"""Authenticated snapshots, persistent atomic generations, cross-process LRU leases."""
import contextlib
import hashlib
import os
import shutil
import sqlite3
import tempfile
import time
from pathlib import Path
from state import FileLock, UserError, atomic_json, digest, read_json
from wechat_reader import PAGE, decrypt_page, mac_key, replay_wal


def fingerprint(path):
    path = Path(path)
    if not path.exists():
        return None
    before = path.stat()
    with path.open('rb') as f:
        h = hashlib.file_digest(f, 'sha256').hexdigest()
    after = path.stat()
    fields = lambda s: (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
    if fields(before) != fields(after):
        raise UserError('源文件读取期间变化，请重试')
    return {'size':after.st_size,'identity':[after.st_dev,after.st_ino], 'sha256':h}


def verify(path):
    with contextlib.closing(sqlite3.connect(Path(path).as_uri()+'?mode=ro&immutable=1',uri=True)) as con:
        if con.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise UserError('解密缓存完整性校验失败')


class Cache:
    def __init__(self, state, limit_mb=2048):
        self.state = state
        self.root = state.root/'cache/decrypted'
        self.limit = limit_mb*1024*1024

    def usage(self):
        files = [p for p in self.root.rglob('*') if p.is_file() and p.suffix!='.lock']
        return {'bytes':sum(p.stat().st_size for p in files), 'limit_bytes':self.limit,
                'entries':len(list(self.root.glob('*/plain.db')))}

    def clean(self, all_unused=False, exclude=(), reserve=0, owners=None):
        removed, freed = 0, 0
        with FileLock(self.root/'manager.lock'):
            entries = sorted([p for p in self.root.iterdir() if p.is_dir()],
                             key=lambda p: (p/'meta.json').stat().st_mtime if (p/'meta.json').exists() else 0)
            total = self.usage()['bytes']
            for folder in entries:
                if folder.name in exclude:
                    continue
                if owners is not None:
                    try: owner=read_json(folder/'meta.json',{}).get('owner')
                    except ValueError: owner=None
                    if owner not in owners: continue
                # Broken/interrupted generations can also be rebuilt; never follow links.
                if folder.is_symlink() or folder.is_junction():
                    continue
                if not all_unused and total+reserve <= self.limit:
                    break
                try:
                    with FileLock(self.root/(folder.name+'.lock'), blocking=False):
                        size = sum(p.stat().st_size for p in folder.rglob('*') if p.is_file())
                        shutil.rmtree(folder)
                        total -= size; freed += size; removed += 1
                except (UserError,OSError):
                    continue
            if removed:
                atomic_json(self.state.root/'logs/cache-clean.json', {'time':time.time(),'removed':removed,'bytes':freed})
        return {**self.usage(), 'removed':removed, 'freed_bytes':freed}

    @contextlib.contextmanager
    def open(self, source, account, rel, key):
        root = Path(source).resolve()
        src = (root/rel).resolve()
        if not src.is_relative_to(root) or src == root:
            raise UserError('数据库路径越界')
        # Prevent configuring the WS data tree as an original WeChat source.
        if src.is_relative_to(self.state.root) or self.state.root.is_relative_to(root):
            raise UserError('原始数据目录不能与 WS 数据目录重叠')
        ident = digest([str(root).casefold(),account,rel,hashlib.sha256(key).hexdigest()])
        folder = self.root/ident
        with FileLock(self.root/(ident+'.lock')):
            folder.mkdir(exist_ok=True)
            # Holding the exclusive entry lease proves these builders are leftovers
            # from a terminated process, rather than a concurrent active update.
            for abandoned in folder.glob('build-*'):
                if abandoned.is_dir() and not abandoned.is_symlink() and not abandoned.is_junction():
                    shutil.rmtree(abandoned)
            output, meta_path = folder/'plain.db', folder/'meta.json'
            wal = Path(str(src)+'-wal')
            before = [fingerprint(src), fingerprint(wal)]
            try:
                meta = read_json(meta_path, {})
            except (ValueError,TypeError):
                meta = {}
            reused = False
            if meta.get('version')==1 and meta.get('source')==before and output.exists():
                try:
                    if fingerprint(output)['sha256'] == meta.get('output_sha256'):
                        verify(output); reused=True
                except (OSError,UserError,sqlite3.Error):
                    pass
            if not reused:
                required = sum(s['size'] for s in before if s)*3
                self.clean(exclude=(ident,), reserve=required)
                if self.usage()['bytes']+required > self.limit:
                    raise UserError('受影响数据库的安全快照超过缓存容量，请提高容量上限')
                if shutil.disk_usage(folder).free < required+128*1024*1024:
                    raise UserError('磁盘剩余空间不足，保留现有缓存并停止生成')
                with tempfile.TemporaryDirectory(prefix='build-',dir=folder) as scratch_name:
                    scratch = Path(scratch_name)
                    copied, copied_wal = scratch/'source.db',scratch/'source.db-wal'
                    # Compare full content of source before/after and with copied files.
                    # A checkpoint or WAL reset during copy forces a fresh attempt.
                    for attempt in range(4):
                        try:
                            before = [fingerprint(src),fingerprint(wal)]
                            shutil.copyfile(src,copied)
                            if before[1]:
                                shutil.copyfile(wal,copied_wal)
                            else:
                                copied_wal.unlink(missing_ok=True)
                            after = [fingerprint(src),fingerprint(wal)]
                            same = all((a is None and b is None) or (a is not None and b is not None and a['size']==b['size'] and a['sha256']==b['sha256'])
                                       for a,b in zip(before,[fingerprint(copied),fingerprint(copied_wal)]))
                            if before==after and same:
                                break
                        except (UserError, FileNotFoundError):
                            pass
                        time.sleep(.2)
                    else:
                        raise UserError('未获得一致的数据库和 WAL 快照，请稍后重试')
                    candidate = scratch/'plain.db'
                    if copied.stat().st_size % PAGE:
                        raise UserError('不支持的数据库页大小或损坏的数据库')
                    with copied.open('rb') as fin, candidate.open('wb') as fout:
                        first=fin.read(PAGE)
                        if len(first)!=PAGE:
                            raise UserError('数据库为空')
                        mk=mac_key(key,first[:16])
                        fout.write(decrypt_page(first,1,key,mk))
                        pgno=2
                        while page:=fin.read(PAGE):
                            fout.write(decrypt_page(page,pgno,key,mk)); pgno+=1
                        fout.flush(); os.fsync(fout.fileno())
                    replay_wal(copied_wal,candidate,key,mk)
                    verify(candidate)
                    output_hash=fingerprint(candidate)['sha256']
                    os.replace(candidate,output)
                    atomic_json(meta_path,{'version':1,'owner':digest([str(root).casefold(),account]),'source':before,'output_sha256':output_hash,'updated':time.time(),'accessed':time.time()})
            else:
                meta['accessed']=time.time();meta['owner']=digest([str(root).casefold(),account]); atomic_json(meta_path,meta)
            with contextlib.closing(sqlite3.connect(output.as_uri()+'?mode=ro&immutable=1',uri=True)) as conn:
                conn.row_factory=sqlite3.Row
                conn.execute('PRAGMA query_only=ON')
                yield conn, {'reused':reused,'id':ident}
