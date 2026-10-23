"""Prepare the pinned official Shell package and a dedicated QQ program copy."""
import hashlib
import json
import secrets
import shutil
import zipfile
from pathlib import Path
from state import UserError, atomic_json, read_json
from progress import emit

ARCHIVE_SHA256='3fc093ba2332b97ac17e16160d5baa6ffe0a8def6c394d515a94777fe0ca492c'


def prepare(state, archive, executable):
    archive=Path(archive);qq=Path(executable).resolve()
    if qq.name.lower()!='qq.exe' or not qq.is_file():raise UserError('请选择已安装的官方 QQ.exe')
    base=state.root/'qq';base.mkdir(exist_ok=True)
    marker=base/'installation.json'
    if marker.exists():
        old=read_json(marker)
        if old.get('version')=='6.3.2' and Path(old.get('qq_exe','')).is_file():return {'prepared':True}
        raise UserError('QQ 专用副本不完整，请保留登录目录并重新配置环境')
    if not archive.is_file():raise UserError('缺少 QCE Shell 资源，请使用完整 WS 程序包')
    with archive.open('rb') as stream:
        if hashlib.file_digest(stream,'sha256').hexdigest()!=ARCHIVE_SHA256:raise UserError('QCE 资源校验失败，请重新下载完整包')
    runtime=base/'shell'
    emit('准备数据',detail='解压 QCE 官方 Shell 资源')
    with zipfile.ZipFile(archive) as z:
        for info in z.infolist():
            parts=Path(info.filename.replace('\\','/')).parts
            if not parts or parts[0]!='NapCat-QCE-Windows-x64':raise UserError('QCE 资源目录结构不兼容')
            target=(runtime/Path(*parts[1:])).resolve()
            if not target.is_relative_to(runtime.resolve()) or info.external_attr>>16 & 0o170000==0o120000:raise UserError('QCE 资源包含无效路径或链接')
            if info.is_dir():target.mkdir(parents=True,exist_ok=True)
            else:
                target.parent.mkdir(parents=True,exist_ok=True)
                with z.open(info) as src,target.open('wb') as dst:shutil.copyfileobj(src,dst)
    root=qq.parent
    # Copy exactly one installed version; never download or redistribute Tencent binaries.
    if (root/'resources/app/package.json').is_file():version_root=root;relative=Path('.')
    else:
        versions=[v for v in (root/'versions').glob('*') if (v/'resources/app/package.json').is_file()]
        if not versions:raise UserError('未找到 QQNT 版本资源，请选择有效的 QQ 安装程序')
        version_root=max(versions,key=lambda p:tuple(int(x) for x in __import__('re').findall(r'\d+',p.name)))
        relative=Path('versions')/version_root.name
    target=base/'client';target.mkdir(exist_ok=True)
    files=[]
    for file in root.iterdir():
        if file.is_file() and (file.suffix.lower()=='.dll' or file.name.lower()=='qq.exe'):
            files.append((file,target/file.name))
    for file in version_root.rglob('*'):
        if file.is_symlink():raise UserError('QQ 程序目录含链接，未跟随复制')
        if file.is_file():files.append((file,target/relative/file.relative_to(version_root)))
    total=sum(f.stat().st_size for f,_ in files)
    if shutil.disk_usage(base).free<total+256*1024*1024:raise UserError('QQ 专用运行副本所需磁盘空间不足')
    for index,(src,dst) in enumerate(files):
        if index%30==0:emit('准备数据',index,len(files),detail='准备单一 QQ 专用运行副本，原安装目录只读')
        dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dst)
    if relative!=Path('.'):
        atomic_json(target/'versions/config.json',{'baseVersion':version_root.name,'curVersion':version_root.name,'prevVersion':'','onErrorVersions':[],
                    'buildId':version_root.name.rsplit('-',1)[-1],'unzipRetryCount':0,'readyVersion':'','readyInstaller':''})
    metadata=read_json(version_root/'resources/app/package.json')
    patch={k:v for k,v in metadata.items() if k in ('name','verHash','version','linuxVersion','linuxVerHash','private','description','productName','author','homepage','sideEffects','bin','buildVersion')}
    patch.update(main='./loadNapCat.js',isPureShell=True,isByteCodeShell=True,platform='win32',eleArch='x64')
    atomic_json(runtime/'qqnt.json',patch)
    loader='(async () => {await import('+json.dumps((runtime/'napcat.mjs').as_uri())+')})()'
    (runtime/'loadNapCat.js').write_text(loader,encoding='utf8')
    (target/relative/'resources/app/loadNapCat.js').write_text(loader,encoding='utf8')
    config=runtime/'config';config.mkdir(exist_ok=True)
    # Normal logs must not collect message content. Login is exposed in the local WebUI.
    atomic_json(config/'napcat.json',{'fileLog':False,'consoleLog':False,'fileLogLevel':'error','consoleLogLevel':'error','packetBackend':'auto','packetServer':'','o3HookMode':1})
    atomic_json(config/'webui.json',{'host':'127.0.0.1','port':6099,'token':secrets.token_hex(24),'loginRate':5})
    profile=base/'profile/.qq-chat-exporter';profile.mkdir(parents=True,exist_ok=True)
    atomic_json(profile/'security.json',{'accessToken':secrets.token_hex(20),'secretKey':secrets.token_hex(32),
                'createdAt':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),
                'allowedIPs':['127.0.0.1','::1'],'serverHost':'127.0.0.1','disableIpWhitelist':False})
    atomic_json(profile/'user-config.json',{'autoOpenBrowser':False,'customOutputDir':str(base/'exports'),'customScheduledExportDir':str(base/'exports')})
    atomic_json(marker,{'version':'6.3.2','qq_exe':str(target/'QQ.exe'),'resource_relative':str(relative/'resources/app'),'program_bytes':total})
    return {'prepared':True,'program_bytes':total}
