"""Reuse the user's Feishu official-API client, with WS-owned DPAPI credentials."""
import asyncio
import json
import sqlite3
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from state import UserError, digest
from feishu_mcp.feishu import FeishuClient


class TokenStore:
    def __init__(self,state,name):
        self.state,self.name=state,name
    def load(self):
        return self.state.secret(self.name)
    def save(self,value):
        self.state.secret(self.name,value,write=True)


class Feishu:
    capabilities={'text':True,'reply':True,'files':True,'images':True,'voice':False,'realtime':False}
    def __init__(self,state,source):
        self.state,self.source=state,source
        credentials=state.secret('feishu-app-'+source['id'])
        if not credentials:
            raise UserError('尚未迁移或授权飞书凭据')
        settings=SimpleNamespace(**credentials,base_url='https://open.feishu.cn',
            download_dir=state.root/'cache/attachments'/source['id'],max_download_bytes=64*1024*1024)
        self.client=FeishuClient(settings,TokenStore(state,'feishu-token-'+source['id']))

    async def verify_account(self):
        info=await self.client._request_json('GET','/open-apis/authen/v1/user_info')
        values={str(info.get(k,'')) for k in ('open_id','union_id','user_id')}-{''}
        if self.source['account_id'] not in values:
            raise UserError('飞书授权账号与配置不一致；请以当前用户稳定 ID 重新绑定，旧任务保留')

    def groups(self):
        async def read():
            await self.verify_account()
            rows=[]; token=''; seen=set()
            while True:
                page=await self.client.list_chats(page_token=token)
                rows.extend({'id':c['chat_id'],'name':c.get('name',c['chat_id'])} for c in page['chats'])
                if not page['has_more']: return rows
                token=page['next_page_token']
                if not token or token in seen: raise UserError('飞书分页状态异常')
                seen.add(token)
        return asyncio.run(read())

    def iter_messages(self,chat,since,until):
        async def read():
            await self.verify_account()
            token=''; seen=set()
            while True:
                page=await self.client.list_messages(chat,str(since),str(until),page_token=token)
                yield page['messages']
                if not page['has_more']: break
                token=page['next_page_token']
                if not token or token in seen: raise UserError('飞书分页状态异常')
                seen.add(token)
        # Use an async generator one page at a time without accumulating whole chats.
        loop=asyncio.new_event_loop()
        gen=read()
        try:
            while True:
                try: rows=loop.run_until_complete(gen.__anext__())
                except StopAsyncIteration: break
                for m in rows:
                    content=m['content']
                    if isinstance(content,dict) and isinstance(content.get('text'),str):
                        text=content['text']
                    else: text=json.dumps(content,ensure_ascii=False)
                    mid=digest(['feishu',self.source['id'],self.source['account_id'],chat,m['message_id']])
                    voice=m['msg_type'] in ('audio','voice')
                    if voice:text='[语音未处理]'
                    attachments=[{'kind':'audio','stages':{'processed':'unprocessed'}}] if voice else []
                    for i,r in enumerate([] if voice else m['resources']):
                        a={'id':digest([mid,i]),'source_message':mid,'kind':'image' if r['type']=='image' else 'document','name':'','stages':{'identified':'ok'}}
                        try:
                            file=loop.run_until_complete(self.client.download_message_resource(m['message_id'],r['key'],r['type']))
                            a.update(local_file=file['path'],mime_type=file.get('content_type',''))
                            a['stages']['located']='ok'
                            if a['kind']=='document':
                                from documents import extract
                                result=extract(file['path']); a['extracted_text']=result['text']; a['truncated']=result['truncated']
                                a['stages']['extracted']='ok'
                            else: a['stages']['vision']='not_authorized_or_unsupported'
                        except Exception as e:
                            a['stages']['extracted']='failed'; a['error']=type(e).__name__
                        attachments.append(a)
                    yield {'id':mid,'schema_version':1,'platform':'feishu','source_id':self.source['id'],'account_id':self.source['account_id'],
                        'chat_id':chat,'chat_name':chat,'message_id':m['message_id'],'sender_id':m['sender'].get('id',''),
                        'sender_name':m['sender'].get('id',''),'timestamp':int(m['create_time'])//1000,'timezone':'Asia/Shanghai',
                        'message_type':m['msg_type'],'content':text[:120000],'attachments':attachments,'reply_to':m['parent_id'] or None,
                        'raw_reference':{'message_id':m['message_id']},'parse_status':'unprocessed' if voice else 'ok','truncated':len(text)>120000}
        finally:
            loop.run_until_complete(gen.aclose()); loop.close()


def import_legacy(state,source,project):
    from dotenv import dotenv_values
    from cryptography.fernet import Fernet
    root=Path(project).resolve()/'server'
    env=dotenv_values(root/'.env')
    database=Path(env.get('FEISHU_TOKEN_DB') or 'data/feishu_tokens.sqlite3')
    if not database.is_absolute(): database=root/database
    # Existing connector may be running in WAL mode. Work on a stable private copy,
    # so SQLite never needs to create shared-memory files in that connector's directory.
    import shutil,tempfile
    from cache import fingerprint
    database=database.resolve()
    wal=Path(str(database)+'-wal')
    with tempfile.TemporaryDirectory(dir=state.root/'cache',prefix='feishu-auth-') as scratch:
        target=Path(scratch)/'tokens.sqlite3'
        for attempt in range(4):
            before=[fingerprint(database),fingerprint(wal)]
            shutil.copyfile(database,target)
            if before[1]:shutil.copyfile(wal,Path(str(target)+'-wal'))
            else:Path(str(target)+'-wal').unlink(missing_ok=True)
            if before==[fingerprint(database),fingerprint(wal)]:break
        else:raise UserError('飞书凭据文件正在更新，请稍后重试导入')
        with closing(sqlite3.connect(target)) as conn:
            row=conn.execute("SELECT encrypted_payload FROM oauth_tokens WHERE subject='current_user'").fetchone()
    if not row: raise UserError('原飞书连接器尚无已授权用户')
    token=json.loads(Fernet(env['FEISHU_TOKEN_ENCRYPTION_KEY'].encode()).decrypt(row[0]))
    state.secret('feishu-token-'+source['id'],token,write=True)
    state.secret('feishu-app-'+source['id'],{'app_id':env['FEISHU_APP_ID'],'app_secret':env['FEISHU_APP_SECRET'],
        'redirect_uri':env.get('FEISHU_REDIRECT_URI','http://127.0.0.1:8001/oauth/callback')},write=True)
    return {'imported':True,'token_validity':'requires_api_check'}
