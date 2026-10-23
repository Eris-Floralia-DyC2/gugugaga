"""One acquisition and analysis pipeline for the current saved conversation selection."""
import time
from datetime import datetime,timedelta
from state import UserError,read_json,atomic_json,FileLock
from progress import emit
from summaries import validate_selection

def default_window(now=None):
    now=now or datetime.now().astimezone()
    midnight=now.replace(hour=0,minute=0,second=0,microsecond=0)
    return {'since':int((midnight-timedelta(days=1)).timestamp()),'until':int((midnight+timedelta(days=1)).timestamp())-1}

def saved_selection(state):
    file=state.root/'config/summary.json';window=default_window()
    value=read_json(file,{'version':1,'selected':[],**window})
    mode=read_json(state.root/'state/summary-window.json',{'mode':'rolling' if not file.exists() else 'custom'})
    if mode.get('mode')=='rolling':
        value={**value,**window};atomic_json(file,value)
        atomic_json(state.root/'state/summary-window.json',{'version':1,'mode':'rolling'})
    return validate_selection(value,allow_empty=True)

def save_selection(state,value):
    value=validate_selection(value,allow_empty=True)
    atomic_json(state.root/'config/summary.json',value)
    window=default_window()
    atomic_json(state.root/'state/summary-window.json',{'version':1,'mode':'rolling' if all(value[k]==window[k] for k in window) else 'custom'})
    return {'saved':True,'selected':len(value['selected'])}

def collect_selected(state,selection,make_adapter):
    from attachments import Attachments
    c=state.config();sources={s['id']:s for s in c['sources']};total=0;errors=[]
    selected=validate_selection(selection,allow_empty=True)
    with FileLock(state.root/'state/collect.lock',blocking=False):
        for index,item in enumerate(selected['selected']):
            source=sources.get(item['source_id']);chat=item['chat_id']
            if not source or not source['enabled']:
                errors.append({'source':item['source_id'],'chat':chat,'error':'数据源已移除或停用，请到数据源设置重新连接'});continue
            try:
                emit('检测连接',index,len(selected['selected']))
                reader=make_adapter(state,source)
                # Validate access using metadata, never other conversations' bodies.
                directory=reader.conversations() if hasattr(reader,'conversations') else reader.groups()
                if chat not in {g['id'] for g in directory}:raise UserError('当前账号已无法读取此会话，请重新连接后按名称选择')
                media=Attachments(state,reader) if source['platform']=='wechat' else None
                batch=[];emit('采集消息',total,detail='读取所选会话及指定时间范围，总量未知')
                effective_until=min(selected['until'],int(time.time()))
                rows=reader.iter_messages(chat,selected['since'],effective_until) if selected['since']<=effective_until else []
                for m in rows:
                    # Defense against a faulty platform adapter returning another chat or range.
                    if m['chat_id']!=chat or not selected['since']<=m['timestamp']<=effective_until:raise UserError('数据源返回了范围外消息，已停止此会话')
                    if media:
                        emit('解析附件',total,detail='仅处理当前消息关联的文件和图片')
                        m=media.process(m)
                    batch.append(m);total+=1
                    if len(batch)>=100:state.save_messages(source['id'],chat,batch,None);batch=[]
                    if total%20==0:emit('采集消息',total)
                if selected['since']<=effective_until:
                    with state.db() as con:con.execute('UPDATE cursors SET until=? WHERE source=? AND chat=? AND until>?',(effective_until,source['id'],chat,effective_until))
                    state.save_messages(source['id'],chat,batch,effective_until)
                from source_health import update
                update(state,source['id'],'collection',True)
            except Exception as e:
                from source_health import update
                from qq import AuthRequired
                errors.append({'source':source['id'],'chat':chat,'error':str(e)[:250] if isinstance(e,UserError) else '读取失败：'+type(e).__name__,'requires_auth':isinstance(e,AuthRequired)})
                update(state,source['id'],'collection',False,errors[-1]['error'],isinstance(e,AuthRequired))
        from source_health import update
        for sid in {e['source'] for e in errors}:
            failures=[e for e in errors if e['source']==sid]
            update(state,sid,'collection',False,'；'.join(e['error'] for e in failures),any(e.get('requires_auth') for e in failures))
        result={'read':total,'errors':errors,'until':selected['until'],'stage':'collected','selection':selected}
        atomic_json(state.root/'state/collection-status.json',{**result,'time':time.time()})
        return result

def enrich_images(state,selection,llm):
    from vision import describe
    from pathlib import Path
    count=0
    for item in selection['selected']:
        for m in state.messages(item['source_id'],item['chat_id'],selection['since'],selection['until'],limit=200):
            changed=False
            for a in m['attachments']:
                if a['kind']!='image' or not a.get('decoded_file') or a['stages'].get('vision')=='ok':continue
                try:
                    target=Path(a['decoded_file']).resolve()
                    if not target.is_relative_to(state.root/'cache/attachments'):raise UserError('图片缓存路径无效')
                    emit('解析图片',count,detail='等待 AI 读取当前消息的图片')
                    r=describe(llm,target);a['extracted_text']='[AI 视觉转录，须核对原图]\n'+r['text']+'\n'+r['description'];a['vision_uncertainty']=r['uncertainty'];a['stages']['vision']='ok'
                except Exception as e:a['stages']['vision']='failed';a['vision_error']=str(e)[:160] if isinstance(e,UserError) else '图片分析失败'
                changed=True;count+=1
            if changed:state.save_messages(item['source_id'],item['chat_id'],[m],None)
    return {'images_checked':count}
