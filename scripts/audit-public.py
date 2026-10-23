"""Read-only heuristic scan. Reports paths/types only, never values or excerpts.

This is not a proof that files are safe to publish. Uninspected content and
heuristic matches require review. Does not load WS state, chats or credentials.
"""
import argparse, hashlib, io, json, os, re, stat, subprocess, types, zipfile
from pathlib import Path

PATTERNS = {
    'personal-windows-path': re.compile(rb'(?i)[A-Z]:[\\/]+Users[\\/]+(?!Public\b|Default\b|Example\b|YOUR_USER\b|<)[^\\/\s"\x00<>]{2,60}[\\/]'),
    'private-key': re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'provider-token-candidate': re.compile(rb'(?<![\w-])(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})'),
    'credential-assignment-candidate': re.compile(rb'''(?i)["']?(?:api[_-]?key|access[_-]?token|app[_-]?secret|secret[_-]?key|password)["']?\s*[:=]\s*["']([^"'\r\n]{16,})["']'''),
}
PRIVATE = re.compile(r'(?i)(^|/)(WS-Private(?:\.pending)?|WS-PRIVATE-MIGRATION[^/]*|secrets|profile|session)(/|$)|\.(dpapi|db|sqlite|sqlite3)(-(wal|shm))?$|\.(db|sqlite|sqlite3)-(wal|shm)$')
SKIP_ROOTS = {'.git','node_modules','.venv','WS-Private','.audit-local'}

def run(args):
    findings=[]; skipped=[]; counters={'files':0,'archive_members':0,'bytes_scanned':0,'embedded_modules':0,'duplicate_files':0}; embedded_cache={}; content_cache={}
    def add(label,kind,line=None):
        value={'file':label,'kind':kind}
        if line is not None:value['line']=line
        findings.append(value)
    def check(label,data):
        counters['bytes_scanned']+=len(data)
        # UTF-16 paths and ASCII data are inspected as well as UTF-8.
        variants=[data]
        if b'\x00' in data[:65536]:variants.append(data.replace(b'\x00',b''))
        for kind,pattern in PATTERNS.items():
            matches=[]
            for content in variants:
                m=pattern.search(content)
                if m:matches.append(content[:m.start()].count(b'\n')+1)
            for line in sorted(set(matches)):add(label,kind,line)
    def code_strings(code):
        yield code.co_filename
        for item in code.co_consts:
            if isinstance(item,str):yield item
            elif isinstance(item,bytes):yield item.decode('utf8',errors='replace')
            elif isinstance(item,types.CodeType):yield from code_strings(item)
    def embedded(file,label):
        if not args.embedded_python:return
        key=hashlib.sha256(file.read_bytes()).hexdigest()
        if key in embedded_cache:
            for kind,module in embedded_cache[key]:add(label+'!'+module,kind)
            return
        start=len(findings)
        try:
            import marshal
            from PyInstaller.archive.readers import CArchiveReader
            archive=CArchiveReader(str(file));pyz=archive.open_embedded_archive('PYZ.pyz')
            for name in pyz.toc:
                code=pyz.extract(name)
                if isinstance(code,types.CodeType):
                    counters['embedded_modules']+=1;check(label+'!PYZ/'+name,'\n'.join(code_strings(code)).encode('utf8'))
            check(label+'!worker-code','\n'.join(code_strings(marshal.loads(archive.extract('worker')))).encode('utf8'))
            embedded_cache[key]=[(f['kind'],f['file'].split('!',1)[1]) for f in findings[start:]]
        except Exception as e:skipped.append({'file':label,'reason':'embedded-python-'+type(e).__name__})
    def zipscan(z,label,depth):
        if depth>3:skipped.append({'file':label,'reason':'nested-archive-depth-limit'});return
        for e in z.infolist():
            if e.is_dir():continue
            name=e.filename.replace('\\','/');member=label+'!'+name;counters['archive_members']+=1
            if PRIVATE.search(name):add(member,'private-file-type')
            if '..' in name.split('/') or name.startswith('/') or re.match(r'^[A-Za-z]:',name):add(member,'archive-path-traversal')
            if stat.S_ISLNK(e.external_attr>>16):add(member,'archive-link')
            if e.flag_bits&1:skipped.append({'file':member,'reason':'encrypted-member'});continue
            if e.file_size>256*1024*1024:skipped.append({'file':member,'reason':'member-over-256MiB'});continue
            try:
                data=z.read(e);check(member,data)
                if name.lower().endswith('.zip'):
                    with zipfile.ZipFile(io.BytesIO(data)) as nested:zipscan(nested,member,depth+1)
            except Exception as ex:skipped.append({'file':member,'reason':type(ex).__name__})
    def filecheck(p,label):
        counters['files']+=1
        if PRIVATE.search(label):add(label,'private-file-type')
        hasher=hashlib.sha256()
        try:
            with p.open('rb') as handle:
                while chunk:=handle.read(1024*1024):hasher.update(chunk)
        except OSError as ex:
            skipped.append({'file':label,'reason':type(ex).__name__});return
        key=hasher.hexdigest()
        if key in content_cache:
            original,matched,unread=content_cache[key];counters['duplicate_files']+=1
            findings.extend([{**item,'file':item['file'].replace(original,label,1)} for item in matched])
            skipped.extend([{**item,'file':item['file'].replace(original,label,1)} for item in unread])
            return
        first_finding=len(findings);first_skip=len(skipped)
        try:
            # Stream larger binaries; preserve overlap so tokens crossing chunks are found.
            if p.stat().st_size>256*1024*1024:
                with p.open('rb') as f:
                    tail=b''
                    while chunk:=f.read(8*1024*1024):
                        check(label,tail+chunk);tail=chunk[-512:]
            else:check(label,p.read_bytes())
            if p.suffix.lower()=='.zip':
                with zipfile.ZipFile(p) as z:zipscan(z,label,0)
            if p.name.lower()=='ws-worker.exe':embedded(p,label)
            if p.suffix.lower() in {'.7z','.rar','.gz','.asar'}:skipped.append({'file':label,'reason':'unsupported-container'})
        except Exception as ex:skipped.append({'file':label,'reason':type(ex).__name__})
        content_cache[key]=(label,findings[first_finding:],skipped[first_skip:])
    def walk(folder,base):
        for e in os.scandir(folder):
            p=Path(e.path);label=str(p.relative_to(base)).replace('\\','/')
            info=e.stat(follow_symlinks=False)
            if getattr(info,'st_file_attributes',0)&0x400 or stat.S_ISLNK(info.st_mode):
                add(str(base.name)+'/'+label,'reparse-point-not-followed');continue
            if e.is_dir(follow_symlinks=False):
                if (e.name in SKIP_ROOTS and (e.name != 'node_modules' or Path(folder) == base)) or (p/'private-root.json').is_file():
                    skipped.append({'file':str(base.name)+'/'+label,'reason':'explicit-private-or-dependency-boundary'});continue
                walk(p,base)
            elif e.is_file(follow_symlinks=False):filecheck(p,str(base.name)+'/'+label)
    for target in args.targets:
        p=Path(target).absolute()
        if p.is_symlink() or p.is_junction():add(p.name,'target-link-not-followed');continue
        if p.name in {'WS-Private','.git'} or (p.is_dir() and (p/'private-root.json').is_file()):raise SystemExit('Refusing to read private root or Git internals as ordinary files')
        if p.is_dir():walk(p,p)
        else:filecheck(p,p.name)
    git_result=None
    if args.git_root:
        root=Path(args.git_root)
        def git(*a):
            r=subprocess.run(['git','-C',str(root),*a],capture_output=True)
            if r.returncode:raise RuntimeError('Git command failed: '+a[0])
            return r.stdout
        refs=git('for-each-ref','--format=%(refname)').decode().splitlines()
        index=git('ls-files','-s','-z').decode().split('\0');blobs={}
        for row in index:
            if row:
                metadata,name=row.split('\t',1);blobs[metadata.split()[1]]='index/'+name
                if PRIVATE.search(name):add('index/'+name,'private-file-type')
        for row in git('rev-list','--objects','--all').decode().splitlines():
            sha,_,name=row.partition(' ')
            if git('cat-file','-t',sha).strip()==b'blob':blobs.setdefault(sha,'history/'+name)
        size=0
        for sha,label in blobs.items():
            data=git('cat-file','blob',sha);size+=len(data);check(label,data)
        git_result={'refs':refs,'reachable_commits':int(git('rev-list','--all','--count') or b'0'),'unique_index_and_history_blobs':len(blobs),'blob_bytes':size,'reflogs_and_unreachable_objects':'not in reachable-history scope; not rewritten'}
    report={'scope':'read-only heuristics; no user state/messages/credentials opened','counts':counters,'git':git_result,'findings':findings,'skipped':skipped}
    out=Path(args.report).absolute()
    private=Path(os.environ.get('WS_PRIVATE_ROOT',Path(__file__).resolve().parents[1]/'WS-Private')).resolve()
    if not out.is_relative_to(private):raise SystemExit('Report must be inside WS_PRIVATE_ROOT')
    out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps({'counts':counters,'findings':len(findings),'skipped':len(skipped),'git':git_result},ensure_ascii=False))
    return 1 if findings or any(s['reason']!='explicit-private-or-dependency-boundary' for s in skipped) else 0

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('targets',nargs='+');parser.add_argument('--report',required=True)
    parser.add_argument('--git-root');parser.add_argument('--embedded-python',action='store_true')
    raise SystemExit(run(parser.parse_args()))
