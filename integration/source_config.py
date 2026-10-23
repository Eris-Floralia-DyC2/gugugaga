"""V3: connections only. Saved workflow selection is the sole execution target."""
import copy,re,time,uuid
from pathlib import Path
from state import UserError,atomic_json,read_json

def account_key(platform,value):
    if platform=='wechat':
        m=re.fullmatch(r'(wxid_[A-Za-z0-9]+)_[a-fA-F0-9]{4,}',value)
        if m:return m.group(1)
    return value

def upgrade(value):
    c=copy.deepcopy(value)
    if c.get('version') in (1,2):
        c={k:v for k,v in c.items() if k not in ('remote_scope','asr_enabled','remote_asr')}
        c['version']=3;c.setdefault('schedule_action','tasks')
        for s in c.get('sources',[]):
            for k in ('groups','remote','range','schedule'):s.pop(k,None)
            s.setdefault('account_name',('微信' if s.get('platform')=='wechat' else '飞书')+'账号')
    return c

def validate(value):
    if not isinstance(value,dict):raise UserError('数据源配置必须为对象')
    c=upgrade(value)
    fields={'version','sources','enabled','daily_time','initial_days','lookback_days','cache_limit_mb','identity','schedule_action'}
    if set(c)!=fields or c.get('version')!=3 or not isinstance(c['sources'],list) or len(c['sources'])>20:raise UserError('不支持的数据源配置版本或字段')
    if type(c['enabled']) is not bool or not isinstance(c['daily_time'],str) or not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d',c['daily_time']):raise UserError('定时设置无效')
    if c['schedule_action'] not in ('summary','tasks'):raise UserError('定时执行类型无效')
    for k,low,high in (('initial_days',1,365),('lookback_days',1,365),('cache_limit_mb',64,1048576)):
        if type(c[k]) is not int or not low<=c[k]<=high:raise UserError('数据源配置数值超出范围')
    if not isinstance(c['identity'],str) or len(c['identity'])>4000:raise UserError('身份说明过长')
    ids=set()
    if sum(s.get('platform')=='qq' for s in c['sources'] if isinstance(s,dict))>1:raise UserError('当前版本使用一个 QQ Shell 登录环境，请保留一个 QQ 数据源')
    for s in c['sources']:
        if not isinstance(s,dict) or set(s)!={'id','platform','account_id','account_name','db_dir','enabled'}:raise UserError('数据源字段无效')
        if not isinstance(s['id'],str) or not re.fullmatch('[a-zA-Z0-9_-]{1,80}',s['id']) or s['id'] in ids:raise UserError('数据源内部标识冲突')
        ids.add(s['id'])
        if s['platform'] not in ('wechat','feishu','qq') or type(s['enabled']) is not bool:raise UserError('平台或状态无效')
        if not isinstance(s['account_id'],str) or not 1<=len(s['account_id'])<=200:raise UserError('请选择账号目录或连接已有授权')
        if not isinstance(s['account_name'],str) or not 1<=len(s['account_name'].strip())<=100:raise UserError('请输入可读的账号名称')
        if not isinstance(s['db_dir'],str) or len(s['db_dir'])>2000 or (s['db_dir'] and not Path(s['db_dir']).is_absolute()):raise UserError('本机目录需为绝对路径')
    return c

def save(state,value):
    previous=state.config();c=validate(value)
    ledger_file=state.root/'state/source-bindings.json';ledger=read_json(ledger_file,{})
    ledger={sid:[v[0],account_key(v[0],v[1]),v[2] if len(v)>2 else v[1]] for sid,v in ledger.items()}
    old={s['id']:s for s in previous['sources']}
    for s in previous['sources']:ledger.setdefault(s['id'],[s['platform'],account_key(s['platform'],s['account_id']),s['account_id']])
    for t in read_json(state.root/'tasks/tasks.json',{'tasks':[]}).get('tasks',[]):
        m=t.get('metadata',{}).get('messageSource',{})
        if m.get('sourceId') and m.get('accountId'):ledger.setdefault(m['sourceId'],[m.get('platform','wechat'),account_key(m.get('platform','wechat'),m['accountId']),m['accountId']])
    for s in c['sources']:
        if s['id'] not in ledger:
            retired=[sid for sid,b in ledger.items() if b[:2]==[s['platform'],account_key(s['platform'],s['account_id'])] and sid not in old]
            if len(retired)==1:s['id']=retired[0];s['account_id']=ledger[s['id']][2]
        if s['id'] in ledger and ledger[s['id']][:2]!=[s['platform'],account_key(s['platform'],s['account_id'])]:s['id']='source-'+uuid.uuid4().hex
        elif s['id'] in old:s['account_id']=old[s['id']]['account_id']
        ledger[s['id']]=[s['platform'],account_key(s['platform'],s['account_id']),s['account_id']]
    if len({s['id'] for s in c['sources']})!=len(c['sources']):raise UserError('同一账号重复，请保留一个数据源')
    atomic_json(state.root/'backups'/('integration-'+str(time.time_ns())+'.json'),previous)
    atomic_json(ledger_file,ledger);atomic_json(state.config_file,c)
    return c
