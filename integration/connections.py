"""Connection repair reuses valid credentials and only asks for missing local steps."""
import time,asyncio,uuid
from pathlib import Path
from state import UserError,atomic_json
from source_config import save,account_key
from progress import emit

def connect(state,source,repair=False):
    emit('检测连接',detail='检查现有连接资料')
    needs=[]
    def inspect():
        from worker import adapter
        r=adapter(state,source)
        rows=r.conversations() if hasattr(r,'conversations') else r.groups()
        if source['platform']=='wechat':
            import re
            from wechat_reader import page_valid,mac_key,PAGE
            shards=[file for file in r.root.glob('message/message_*.db') if re.fullmatch(r'message_\d+\.db',file.name)]
            if not shards:raise UserError('当前账号尚无可读取的本地消息文件，请在微信打开目标会话后重试')
            for file in shards:
                hx=r.keys.get(file.relative_to(r.root).as_posix())
                if not hx:raise UserError('部分消息文件尚未连接，请保持微信登录后重新连接')
                with file.open('rb') as stream:page=stream.read(PAGE)
                key=bytes.fromhex(hx)
                if len(key)!=32 or not page_valid(page,1,mac_key(key,page[:16])):raise UserError('消息文件的连接资料已失效，请重新连接')
        return r,rows
    try:
        if source['platform']=='qq':
            from qq import QQ
            r=QQ(state,source)
            me=r.verify_account(bind=repair)
            if repair:
                from qq_accounts import bind
                source=bind(state,source,me)
                r=QQ(state,source)
            rows=r.conversations()
            result={'ok':True,'state':'connected','source_id':source['id'],'checked_at':time.time(),'conversations':len(rows),'reason':'QQ 已登录，连接正常','needs':[]}
            state.secret('qq-'+source['id'],{'account_id':source['account_id']},write=True)
            atomic_json(state.root/('state/connection-'+source['id']+'.json'),result)
            from source_health import update
            update(state,source['id'],'connection',True)
            return result
        if source['platform']=='wechat':
            root=Path(source['db_dir'])
            if not root.is_dir() or root.name!='db_storage':
                needs=['directory'];raise UserError('微信数据目录失效，请重新选择当前账号的 db_storage 文件夹')
            if account_key('wechat',root.parent.name)!=account_key('wechat',source['account_id']):
                needs=['directory'];raise UserError('目录属于另一账号，请在编辑连接中重新绑定')
            try:secret=state.secret('wechat-'+source['id']) or {}
            except UserError:
                if not repair:raise
                # Preserve machine-bound data before asking the logged-in client to reconnect.
                import shutil
                credential=state.root/'secrets'/('wechat-'+source['id']+'.dpapi')
                shutil.copy2(credential,state.root/'backups'/('connection-before-repair-'+str(time.time_ns())+'.dpapi'))
                credential.unlink();secret={}
            if secret.get('db_dir')!=str(root.resolve()) and secret.get('keys'):
                # Revalidate every reused key against the new path before binding it.
                from wechat_reader import page_valid,mac_key,PAGE
                valid={}
                for rel,hx in secret['keys'].items():
                    file=(root/rel).resolve()
                    if not file.is_relative_to(root.resolve()) or not file.is_file():continue
                    with file.open('rb') as stream:page=stream.read(PAGE)
                    key=bytes.fromhex(hx)
                    if len(key)==32 and page_valid(page,1,mac_key(key,page[:16])):valid[rel]=hx
                if valid:state.secret('wechat-'+source['id'],{'db_dir':str(root.resolve()),'keys':valid},write=True)
        try:r,rows=inspect()
        except Exception:
            if not repair or source['platform']!='wechat':raise
            emit('检测连接',detail='请保持微信已登录，正在只读修复连接')
            from wechat import scan
            scan(state,source)
            r,rows=inspect()
        if repair and source['platform']=='wechat':
            me=next((v for v in rows if v['id']==account_key('wechat',source['account_id'])),None)
            if me and me['name_source']!='identifier' and source['account_name'] in ('我的微信','微信账号'):
                c=state.config();next(s for s in c['sources'] if s['id']==source['id'])['account_name']=me['name'];save(state,c)
        result={'ok':True,'state':'connected','checked_at':time.time(),'conversations':len(rows),'reason':'连接正常','needs':[]}
    except Exception as e:
        if source['platform']=='wechat' and not needs:needs=['client','connection_file']
        if source['platform']=='feishu':needs=['feishu_authorization']
        if source['platform']=='qq':
            from qq import AuthRequired
            needs=['qq_authorization'] if isinstance(e,AuthRequired) else ['qq_retry']
        text=str(e) if isinstance(e,UserError) else '连接失败：'+type(e).__name__
        if '20037' in str(e) or 'expired' in str(e).lower():text='飞书登录授权已过期，请在原连接器重新登录后导入连接'
        if source['platform']=='wechat' and not needs==['directory']:text+='；请保持微信登录后重试连接，或导入已有连接文件'
        result={'ok':False,'state':'requires_reconnect','checked_at':time.time(),'reason':text[:350],'needs':needs}
    atomic_json(state.root/('state/connection-'+source['id']+'.json'),result)
    from source_health import update
    update(state,source['id'],'connection',result['ok'],result['reason'],requires_auth='qq_authorization' in needs)
    return result

def import_feishu(state,source,path):
    from feishu import import_legacy,Feishu
    probe={**source,'id':'probe-'+uuid.uuid4().hex}
    try:
        import_legacy(state,probe,path)
        reader=Feishu(state,probe)
        info=asyncio.run(reader.client._request_json('GET','/open-apis/authen/v1/user_info'))
        account=str(info.get('open_id') or info.get('user_id') or '')
        if not account:raise UserError('飞书未返回当前用户账号，请重新登录')
        c=state.config();s=next(s for s in c['sources'] if s['id']==source['id'])
        s.update(account_id=account,account_name=info.get('name') or '飞书账号',enabled=True)
        c=save(state,c);target=next(s for s in c['sources'] if s['account_id']==account)
        for prefix in ('feishu-app-','feishu-token-'):state.secret(prefix+target['id'],state.secret(prefix+probe['id']),write=True)
        return {'imported':True,'source_id':target['id'],'connection':connect(state,target)}
    finally:
        for prefix in ('feishu-app-','feishu-token-'):(state.root/'secrets'/(prefix+probe['id']+'.dpapi')).unlink(missing_ok=True)

