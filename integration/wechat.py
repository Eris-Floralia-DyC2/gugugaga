"""WeChat adapter. Crypto and read-only key scanner reused from audited local project."""
import hashlib
import json
import re
from contextlib import closing
from pathlib import Path
from defusedxml import ElementTree as ET
import zstandard
import wechat_reader as upstream
from state import UserError, digest
from cache import Cache


class LeaseConnection:
    def __init__(self, manager):
        self.manager=manager
        self.conn,self.info=manager.__enter__()
    def execute(self,*args):
        return self.conn.execute(*args)
    def close(self):
        self.manager.__exit__(None,None,None)


class WeChat(upstream.Reader):
    capabilities = {'text':True,'reply':True,'files':True,'images':True,'voice':False,'realtime':False}
    def __init__(self,state,source):
        self.state,self.source=state,source
        self.settings={'db_dir':source['db_dir'],'groups':[]}
        self.root=Path(source['db_dir']).resolve()
        if not self.root.is_dir() or self.root.name!='db_storage':
            raise UserError('微信数据目录不存在或不是 db_storage')
        from source_config import account_key
        if account_key('wechat',self.root.parent.name) != account_key('wechat',source['account_id']):
            raise UserError('微信目录与账号 ID 不一致，请重新绑定账号；旧任务保留')
        secret=state.secret('wechat-'+source['id']) or {}
        if secret.get('db_dir')!=str(self.root):
            raise UserError('当前账号尚未初始化密钥，请导入或只读扫描')
        self.keys=secret.get('keys',{})
        self.cache=Cache(state,state.config()['cache_limit_mb'])

    def db(self,rel):
        if rel not in self.keys:
            raise UserError('数据库尚无有效密钥：'+rel)
        key=bytes.fromhex(self.keys[rel])
        if len(key)!=32:
            raise UserError('数据库密钥长度错误')
        return LeaseConnection(self.cache.open(self.root,self.source['account_id'],rel,key))

    def close(self):
        pass

    def conversations(self):
        # Read the current account's actual contact fields; never infer a remark.
        with closing(self.db('contact/contact.db')) as conn:
            columns={r['name'] for r in conn.execute('PRAGMA table_info(contact)')}
            fields=['username']+[k for k in ('remark','nick_name') if k in columns]
            rows=[dict(r) for r in conn.execute('SELECT '+','.join(fields)+' FROM contact')]
        out=[]
        for row in rows:
            key=row['username']
            if not (key.endswith('@chatroom') or ('@' not in key and not key.startswith('gh_') and key not in ('weixin','filehelper','fmessage','medianote','floatbottle','newsapp','notifymessage'))):continue
            remark=str(row.get('remark') or '').strip()
            nickname=str(row.get('nick_name') or '').strip()
            out.append({'id':key,'name':remark or nickname or key,'remark':remark,'nickname':nickname,
                        'aliases':list(dict.fromkeys(v for v in (remark,nickname) if v)),
                        'name_source':'remark' if remark else 'nickname' if nickname else 'identifier',
                        'kind':'group' if key.endswith('@chatroom') else 'private'})
        return out

    def iter_messages(self,chat,since,until):
        if not isinstance(chat,str) or not chat or '/' in chat or '\\' in chat:
            raise UserError('会话标识无效，请重新选择会话')
        names=self.contacts()
        table='Msg_'+hashlib.md5(chat.encode()).hexdigest()
        shards=[p.relative_to(self.root).as_posix() for p in upstream.relevant_files(self.root) if p.parent.name=='message' and re.fullmatch(r'message_\d+\.db',p.name)]
        if not shards or set(shards)-set(self.keys):
            raise UserError('缺少消息分片密钥，采集游标未推进')
        seen=set()
        for rel in sorted(shards):
            with closing(self.db(rel)) as conn:
                if not conn.execute('SELECT 1 FROM sqlite_master WHERE name=? AND type=?',(table,'table')).fetchone():
                    continue
                cols={r['name'] for r in conn.execute(f'PRAGMA table_info([{table}])')}
                if not {'local_id','local_type','create_time','message_content'}<=cols:
                    raise UserError('微信消息结构已变化，当前版本不兼容')
                mapping={}
                if conn.execute("SELECT 1 FROM sqlite_master WHERE name='Name2Id'").fetchone():
                    mapping={r[0]:r[1] for r in conn.execute('SELECT rowid,user_name FROM Name2Id')}
                extra=','.join(c if c in cols else 'NULL AS '+c for c in ('real_sender_id','server_id','compress_content','WCDB_CT_message_content'))
                query=f'SELECT local_id,local_type,create_time,message_content,{extra} FROM [{table}] WHERE create_time>=? AND create_time<=? ORDER BY create_time,local_id'
                for row in conn.execute(query,(since,until)):
                    raw=row['message_content'] or row['compress_content'] or ''
                    if isinstance(raw,bytes):
                        if row['WCDB_CT_message_content']==4 or raw.startswith(bytes.fromhex('28b52ffd')):
                            raw=zstandard.ZstdDecompressor().decompress(raw,max_output_size=4*1024*1024)
                        raw=raw.decode('utf-8','replace')
                    raw=str(raw)
                    sender=mapping.get(row['real_sender_id'],'')
                    if ':\n' in raw:
                        prefix,body=raw.split(':\n',1)
                        if prefix==sender or prefix in names or prefix in mapping.values():
                            sender,raw=prefix,body
                    kind=int(row['local_type']) & 0xffffffff
                    native=f'server:{row["server_id"]}' if row['server_id'] else f'{rel}:{row["local_id"]}:{row["local_type"]}'
                    mid=digest(['wechat',self.source['id'],self.source['account_id'],chat,native])
                    if mid in seen:continue
                    seen.add(mid)
                    content,reply,attachments,status=parse_content(raw,kind)
                    yield {'id':mid,'schema_version':1,'platform':'wechat','source_id':self.source['id'],
                           'account_id':self.source['account_id'],'chat_id':chat,'chat_name':names.get(chat,chat),
                           'message_id':native,'sender_id':sender,'sender_name':names.get(sender,sender),
                           'timestamp':int(row['create_time']),'timezone':'Asia/Shanghai','message_type':kind,
                           'content':content,'attachments':attachments,'reply_to':reply,'parse_status':status,
                           'raw_reference':{'database':rel,'local_id':row['local_id'],'type':int(row['local_type'])},
                           'truncated':len(raw)>120000}

    def resources(self,message):
        """Scope resource joins by chat AND local id; ambiguous matches stay unresolved."""
        rel='message/message_resource.db'
        if rel not in self.keys:
            return []
        with closing(self.db(rel)) as con:
            cols={r['name'] for r in con.execute('PRAGMA table_info(MessageResourceInfo)')}
            localcol='message_local_id' if 'message_local_id' in cols else 'local_id'
            if not {localcol,'packed_info'}<=cols:
                return []
            # Avoid upstream local_id-only lookup: local ids collide across chats/shards.
            chatcol=next((c for c in ('chat_id','chat_name','user_name','username') if c in cols),None)
            rows=con.execute(f'SELECT * FROM MessageResourceInfo WHERE [{localcol}]=?',(message['raw_reference']['local_id'],)).fetchall()
            if chatcol=='chat_id' and con.execute("SELECT 1 FROM sqlite_master WHERE name='ChatName2Id'").fetchone():
                mapped=con.execute('SELECT rowid FROM ChatName2Id WHERE user_name=?',(message['chat_id'],)).fetchone()
                if not mapped: return []
                rows=[r for r in rows if r['chat_id']==mapped[0]]
            elif chatcol:
                rows=[r for r in rows if str(r[chatcol])==message['chat_id']]
            elif 'chat_id' not in cols:
                return []
            if 'message_create_time' in cols:
                rows=[r for r in rows if r['message_create_time']==message['timestamp']]
            if len(rows)!=1: return []
            result=dict(rows[0])
            if 'message_id' in result and con.execute("SELECT 1 FROM sqlite_master WHERE name='MessageResourceDetail'").fetchone():
                result['details']=[dict(r) for r in con.execute('SELECT * FROM MessageResourceDetail WHERE message_id=?',(result['message_id'],))]
            return [result]


def parse_content(raw,kind):
    attachments,reply=[],None
    content=raw[:120000]
    status='ok'
    if kind in (3,34,43,47):
        attachments=[{'kind':{3:'image',34:'audio',43:'video',47:'sticker'}[kind], 'name':'', 'md5':'', 'stages':{'identified':'ok'}}]
    if kind==34:
        return '[语音未处理]',None,[{'kind':'audio','name':'','stages':{'identified':'ok','processed':'unprocessed'}}],'unprocessed'
    if kind in (3,49) and raw.lstrip().startswith('<'):
        try:
            root=ET.fromstring(raw[:4*1024*1024])
            def txt(path):
                return (root.findtext(path) or '').strip()
            ref=root.find('.//refermsg')
            if ref is not None:
                reply={'message_id':ref.findtext('svrid'),'sender':ref.findtext('displayname'), 'content':ref.findtext('content')}
            if kind==49:
                title=txt('.//appmsg/title')
                subtype=txt('.//appmsg/type')
                content='\n'.join(x for x in (title,txt('.//appmsg/des'),txt('.//appmsg/url')) if x)
                if subtype=='6':
                    ext=txt('.//appattach/fileext')
                    attachments.append({'kind':'document','name':title,'extension':ext,
                                        'md5':txt('.//appattach/md5'),'stages':{'identified':'ok'}})
                if not content:
                    status='partial'; content=raw[:120000]
            else:
                node=root.find('.//img' if kind==3 else './/voicemsg')
                if node is not None:
                    attachments[0]['md5']=node.get('md5','')
                    attachments[0]['filename']=node.get('filename','')
            if reply:
                content+='\n引用：'+str(reply.get('content') or '')
        except Exception:
            status='xml_failed'
    elif kind not in (1,3,34,43,47,49):
        status='unsupported_type'
    return content[:120000],reply,attachments,status


def scan(state,source):
    # Scanner dependencies are injected; no legacy web monitor or raw key file is used.
    upstream.config=lambda: {'db_dir':source['db_dir'],'groups':[]}
    upstream.get_secret=lambda name,default=None: state.secret('wechat-'+source['id']) or default
    upstream.set_secret=lambda name,value: state.secret('wechat-'+source['id'],value,write=True)
    upstream.DATA=state.root/'logs'
    original=upstream.relevant_files
    upstream.relevant_files=lambda root: sorted(set(original(root)+[p for p in [Path(root)/'message/message_resource.db'] if p.is_file()]))
    try:
        return upstream.scan_keys()
    finally:
        upstream.relevant_files=original


def import_keys(state,source,path):
    from state import read_json
    value=read_json(path)
    root=Path(source['db_dir']).resolve()
    if 'ciphertext' in value:
        import base64
        from state import dpapi
        value=json.loads(dpapi(base64.b64decode(value['ciphertext']),True))
    # Authenticate against current pages; a legacy machine path is not a key identity.
    mapping=value.get('keys',value)
    keys={}
    for name,value in mapping.items():
        rel=name.replace('\\','/')
        file=(root/rel).resolve()
        if not file.is_relative_to(root) or not file.is_file():
            continue
        hx=value.get('enc_key','') if isinstance(value,dict) else value
        try:
            key=bytes.fromhex(hx)
        except (ValueError,TypeError):
            continue
        with file.open('rb') as f:
            page=f.read(upstream.PAGE)
        if len(key)==32 and upstream.page_valid(page,1,upstream.mac_key(key,page[:16])):
            keys[rel]=hx
    if not keys:
        raise UserError('未找到与当前数据库匹配的有效密钥')
    prior=state.secret('wechat-'+source['id']) or {}
    if prior.get('db_dir')==str(root):
        keys={**prior.get('keys',{}),**keys}
    state.secret('wechat-'+source['id'],{'db_dir':str(root),'keys':keys},write=True)
    return {'validated_keys':len(keys)}

