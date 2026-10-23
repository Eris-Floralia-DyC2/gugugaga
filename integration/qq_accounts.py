"""Remember account-specific connection namespaces and selections, never credentials."""
import uuid
from state import read_json,atomic_json,UserError
from source_config import save

def remember(state,source):
    file=state.root/'state/qq-accounts.json';book=read_json(file,{'version':1,'accounts':{}})
    selection=read_json(state.root/'config/summary.json',{'selected':[]})
    prior=book['accounts'].get(source['account_id'],{})
    selected=[v for v in selection['selected'] if v['source_id']==source['id']]
    # A switching flow has already removed the old selection from the active page.
    switching=read_json(state.root/'state/qq-switch.json',{}).get('pending',False)
    book['accounts'][source['account_id']]={'source':source,'selected':prior.get('selected',[]) if switching and not selected else selected}
    atomic_json(file,book)
    return book

def begin_switch(state,sid):
    source=next((s for s in state.config()['sources'] if s['id']==sid and s['platform']=='qq'),None)
    if not source:raise UserError('QQ 数据源不存在，请先添加 QQ 连接')
    remember(state,source)
    atomic_json(state.root/'state/qq-switch.json',{'version':1,'pending':True,'previous_source':sid})
    selection=read_json(state.root/'config/summary.json',None)
    if selection:
        selection['selected']=[v for v in selection['selected'] if v['source_id']!=sid]
        atomic_json(state.root/'config/summary.json',selection)
    return {'switching':True,'reason':'旧账号任务和消息保留；登录新账号后请确认当前账号并连接，再选择新账号会话'}

def bind(state,source,me):
    book=remember(state,source)
    previous=book['accounts'].get(me['account_id'],{})
    changed=me['account_id']!=source['account_id']
    target=previous.get('source') if changed else source
    target={**(target or source),**me,'enabled':True,'id':(target or {}).get('id') or ('source-'+uuid.uuid4().hex)}
    if changed and target['id']==source['id']:target['id']='source-'+uuid.uuid4().hex
    c=state.config();c['sources']=[s for s in c['sources'] if s['platform']!='qq']+[target]
    c=save(state,c);target=next(s for s in c['sources'] if s['platform']=='qq')
    selection=read_json(state.root/'config/summary.json',None)
    if selection:
        qqids={v['source']['id'] for v in book['accounts'].values()}|{source['id'],target['id']}
        switching=read_json(state.root/'state/qq-switch.json',{}).get('pending',False)
        if changed or switching:
            selection['selected']=[v for v in selection['selected'] if v['source_id'] not in qqids]
            selection['selected'] += [{**v,'source_id':target['id']} for v in previous.get('selected',[])][:20-len(selection['selected'])]
            atomic_json(state.root/'config/summary.json',selection)
    atomic_json(state.root/'state/qq-switch.json',{'version':1,'pending':False})
    remember(state,target)
    return target
