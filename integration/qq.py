"""QCE 6.3.2 Shell API only. No local NTQQ database reader or alternate mode."""
import json
import time
from pathlib import Path
from urllib.parse import quote
import httpx
from state import UserError, digest, read_json, atomic_json

PORT = 40653


def local_path(value):
    # QCE uses Windows namespaced paths for long export names. Compare the same
    # canonical spelling on both sides; the normal parent containment check remains.
    value=str(value)
    if value.startswith('\\\\?\\UNC\\'):value='\\\\'+value[8:]
    elif value.startswith('\\\\?\\'):value=value[4:]
    return Path(value).resolve()


class AuthRequired(UserError):
    pass


class QQ:
    def __init__(self, state, source):
        self.state, self.source = state, source
        session=read_json(state.root/'state/qq-session.json',{})
        if session.get('paused') or session.get('switching'):
            raise UserError('QQ 后台已暂停，请在数据源设置点击启动 QQ 后台；切换账号时请先确认当前账号并连接')
        self.base = state.root/'qq'
        self.exports = self.base/'exports'
        self.exports.mkdir(parents=True, exist_ok=True)
        security = read_json(self.base/'profile/.qq-chat-exporter/security.json', {})
        if security.get('allowedIPs') != ['127.0.0.1', '::1'] or security.get('disableIpWhitelist') is not False:
            raise UserError('QQ 本机访问保护未就绪，请在设置中准备 QQ 环境')
        self.token = security.get('accessToken', '')
        self._directory = None
        if not self.token:
            raise AuthRequired('QQ 需要重新授权，请在数据源设置中打开 QQ 登录')

    def api(self, method, route, body=None):
        # No configurable remote endpoint, redirects, proxy, or arbitrary RPC.
        try:
            with httpx.Client(timeout=140, follow_redirects=False, trust_env=False) as client:
                with client.stream(method, f'http://127.0.0.1:{PORT}'+route,
                                   headers={'Authorization': 'Bearer '+self.token}, json=body) as r:
                    if r.status_code in (401, 403):
                        raise AuthRequired('QQ 本机接口凭据不匹配，请重启 QQ 后台后重新连接；这不等于 QQ 账号登录已失效')
                    if r.status_code != 200:
                        raise UserError(f'QQ 采集接口异常（HTTP {r.status_code}），请刷新状态或重启 QQ 后台；已有任务保留')
                    chunks=[]; size=0
                    for chunk in r.iter_bytes():
                        size += len(chunk)
                        if size > 8*1024*1024:
                            raise UserError('QQ 接口响应过大，请缩小范围')
                        chunks.append(chunk)
            value=json.loads(b''.join(chunks))
            if value.get('success') is not True or not isinstance(value.get('data'), dict):
                raise UserError('QQ 接口响应结构无效，未推进采集进度')
            return value['data']
        except httpx.ConnectError:
            raise UserError('QQ 采集接口未启动或连接被拒绝，请点击启动或重启 QQ 后台；这不代表 QQ 授权已失效') from None
        except httpx.TimeoutException:
            raise UserError('QQ 采集接口响应超时，请刷新状态或重启 QQ 后台；已有消息和任务保留') from None
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            raise UserError('QQ 采集接口连接或响应异常，请刷新状态；持续异常时重启 QQ 后台') from None

    def verify_account(self, bind=False):
        info=self.api('GET','/api/system/info')
        napcat=info.get('napcat', {})
        if info.get('mode') == 'standalone' or napcat.get('workingEnv') != 'shell':
            raise UserError('QQ 必须使用 QCE Shell 完整模式，独立浏览模式无法采集新消息')
        me=napcat.get('selfInfo', {})
        account=me.get('uin')
        if not napcat.get('online') or not isinstance(account, str) or not account:
            raise AuthRequired('QQ 需要重新授权，请在设置中扫码登录')
        if not bind and account != self.source['account_id']:
            raise AuthRequired('QQ 登录账号已改变，请在数据源设置中重新绑定账号；原任务保留')
        if info.get('version') != '6.3.2':
            raise UserError('QQ 采集版本与已验证接口不一致，请使用随 WS 配置的 QCE 6.3.2')
        return {'account_id':account,'account_name':me.get('nick') or '我的 QQ'}

    def conversations(self):
        if self._directory is not None:return self._directory
        self.verify_account()
        rows=[]
        for route, field in (('groups','groups'),('friends','friends')):
            for page in range(1,101):
                data=self.api('GET',f'/api/{route}?page={page}&limit=999')
                if not isinstance(data.get(field),list) or type(data.get('hasNext')) is not bool:
                    raise UserError('QQ 会话目录不完整，请重试连接')
                for item in data[field]:
                    native=item.get('groupCode' if route=='groups' else 'uid')
                    if not isinstance(native,str) or not native:
                        raise UserError('QQ 会话身份无效，未猜测账号或群号')
                    kind='group' if route=='groups' else 'private'
                    name=(item.get('groupName') if kind=='group' else item.get('remark') or item.get('nick')) or native
                    rows.append({'id':kind+':'+native,'name':str(name),'kind':kind,
                                 'aliases':list(dict.fromkeys(str(v) for v in (name,item.get('remark'),item.get('nick')) if v))})
                if not data['hasNext']:break
            else:raise UserError('QQ 会话目录超过本次读取上限')
        self._directory=rows
        return rows

    def iter_messages(self, chat, since, until):
        self.verify_account()
        kind, sep, peer=chat.partition(':')
        if kind not in ('group','private') or not sep or not peer:
            raise UserError('QQ 会话标识无效，请重新按名称选择')
        directory={v['id']:v for v in self.conversations()}
        if chat not in directory:raise UserError('QQ 已无法读取此会话，请重新选择')
        name=directory[chat]['name']
        with self.state.db() as con:
            cursor=con.execute('SELECT until FROM cursors WHERE source=? AND chat=?',(self.source['id'],chat)).fetchone()
            if cursor and until>=cursor[0]:
                incremental=max(since,cursor[0]-300)
                # Re-export failed image/document references so newly available files can recover.
                for payload,stamp in con.execute('SELECT payload,timestamp FROM messages WHERE source=? AND chat=? AND timestamp>=? AND timestamp<=?',(self.source['id'],chat,since,until)):
                    m=json.loads(payload)
                    if any(a['kind'] in ('image','document') and (a.get('error') or a.get('stages',{}).get('vision' if a['kind']=='image' else 'extracted')!='ok') for a in m['attachments']):incremental=min(incremental,stamp)
                since=min(incremental,until)
        marker=self.base/'pending-exports'/f'{digest([self.source["account_id"],chat,since,until])}.json'
        task=read_json(marker, {})
        if not task:
            task=self.api('POST','/api/messages/export',{
                'peer':{'chatType':2 if kind=='group' else 1,'peerUid':peer,'guildId':''},
                'sessionName':name,'format':'JSON','filter':{'startTime':since,'endTime':until},
                'options':{'outputDir':str(self.exports),'includeResourceLinks':True,'includeSystemMessages':True,
                           'prettyFormat':False,'filterPureImageMessages':False,'skipDownloadResourceTypes':['audio','video']}})
            if not isinstance(task.get('taskId'),str):raise UserError('QQ 未返回导出任务标识')
            atomic_json(marker,task)
        taskid=task['taskId']
        deadline=time.monotonic()+600
        while time.monotonic()<deadline:
            result=self.api('GET','/api/tasks/'+quote(taskid,safe=''))
            if result.get('status')=='completed':
                task=result;break
            if result.get('status') in ('failed','cancelled'):
                marker.unlink(missing_ok=True)
                raise UserError('QQ 导出失败或被取消，已有消息与任务保留；请重试')
            if result.get('status') not in ('queued','pending','running'):
                raise UserError('QQ 导出状态无法识别，未作为空消息导入')
            from progress import emit
            emit('采集消息',detail='等待 QQ 自动导出当前会话的新消息')
            time.sleep(1)
        else:raise UserError('QQ 导出尚未完成，稍后重试将继续等待同一任务')
        if task.get('partial') or task.get('roamingScan',{}).get('partial'):
            raise UserError('QQ 报告消息采集存在已知缺失，未推进采集进度')
        file=local_path(task.get('filePath',''))
        if not file.is_relative_to(self.exports.resolve()) or not file.is_file() or file.suffix.lower()!='.json':
            raise UserError('QQ 导出文件未完成或超出专用导出目录')
        if file.stat().st_size>64*1024*1024:raise UserError('QQ 导出超过 64MB，请缩小时间范围')
        body=read_json(file)
        if not isinstance(body,dict) or not isinstance(body.get('messages'),list):
            raise UserError('QQ JSON 导出格式不兼容')
        info=body.get('chatInfo',{})
        if info.get('selfUin') != self.source['account_id'] or info.get('type')!=kind or str(info.get('peerUid',''))!=peer:
            raise UserError('QQ 导出账号或会话身份不匹配，未保存消息')
        count=task.get('messageCount')
        if type(count) is not int or count != len(body['messages']):
            raise UserError('QQ 导出条数不完整，未推进采集进度')
        # Validate the entire completed file before yielding any record.
        records=[self.normalize(row,chat,name,kind,file.parent) for row in body['messages']]
        self.verify_account()  # Account must remain the same throughout the export.
        if any(not since<=m['timestamp']<=until for m in records):
            raise UserError('QQ 导出包含范围外消息，未推进采集进度')
        for m in records:yield m
        marker.unlink(missing_ok=True)

    def normalize(self,row,chat,name,kind,folder):
        from schemas import Message
        from attachments import process_file
        native=row.get('id')
        if not isinstance(native,str) or not native:raise UserError('QQ 消息 ID 必须是原始字符串，不能接受已丢失精度的数值')
        stamp=row.get('timestamp')
        if type(stamp) is not int or stamp<0:raise UserError('QQ 消息时间无效')
        content=row.get('content',{});sender=row.get('sender',{})
        if not isinstance(content,dict) or not isinstance(sender,dict):raise UserError('QQ 消息正文结构无效')
        text=content.get('text','')
        if not isinstance(text,str):raise UserError('QQ 消息文本无效')
        mid=digest(['qq',self.source['account_id'],chat,native])
        attachments=[]
        resources=content.get('resources',[])
        if not isinstance(resources,list):raise UserError('QQ 附件结构无效')
        for i,r in enumerate(resources):
            typ=r.get('type','unknown')
            a={'id':digest([mid,i]),'kind':{'file':'document'}.get(typ,typ),'name':str(r.get('filename') or ''),
               'stages':{'identified':'ok'},'reference':{'type':typ,'localPath':r.get('localPath')}}
            path=Path(str(r.get('localPath') or ''))
            candidate=local_path(folder/path) if not path.is_absolute() else local_path(path)
            # Only QCE-owned downloaded resources may be opened; URLs are never fetched here.
            roots=[self.exports.resolve(),(self.base/'profile/.qq-chat-exporter').resolve()]
            if any(candidate.is_relative_to(root) for root in roots) and candidate.is_file():
                process_file(self.state,a,candidate,self.source['id'])
            else:a.update(error='QQ 附件尚未下载或关联文件不可用');a['stages']['located']='failed'
            attachments.append(a)
        resource_types={r.get('type') for r in resources}
        for e in content.get('elements',[]):
            typ=e.get('type')
            if typ not in ('text','at','face','reply','system') and typ not in resource_types:
                attachments.append({'kind':{'file':'document'}.get(typ,typ or 'unknown'),'stages':{'identified':'ok','extracted':'unsupported'},'error':'QQ 消息元素未完整解析'})
        result={'id':mid,'schema_version':1,'platform':'qq','source_id':self.source['id'],'account_id':self.source['account_id'],
                'chat_id':chat,'chat_name':name,'message_id':native,'sender_id':str(sender.get('uid') or sender.get('uin') or ''),
                'sender_name':str(sender.get('groupCard') or sender.get('remark') or sender.get('name') or sender.get('nickname') or ''),
                'timestamp':stamp//1000,'timezone':'Asia/Shanghai','message_type':'text','content':text[:120000],
                'attachments':attachments,'reply_to':None,'parse_status':'partial' if attachments else 'ok',
                'raw_reference':{'collector':'qce-6.3.2','chat_kind':kind},'truncated':len(text)>120000}
        # Avoid repeating image analysis when a successful matching cache is already indexed.
        with self.state.db() as con:old=con.execute('SELECT payload FROM messages WHERE id=?',(mid,)).fetchone()
        if old:
            prior={a.get('id'):a for a in json.loads(old[0])['attachments']}
            for a in attachments:
                p=prior.get(a.get('id'),{})
                if a.get('source_fingerprint') and a.get('source_fingerprint')==p.get('source_fingerprint') and p.get('stages',{}).get('vision')=='ok':
                    a.clear();a.update(p)
        return Message.model_validate(result).model_dump(mode='json')
