"""Bounded authorized LLM batches and durable outbox, independent of source collection."""
import json
import time
from datetime import datetime,timezone,timedelta
from urllib.parse import urlparse
import httpx
from state import UserError, digest, read_json
from proposal_rules import SYSTEM, validate_proposals

TZ=timezone(timedelta(hours=8))


def endpoint(base):
    u=urlparse(base)
    if u.username or u.password or u.query or u.fragment or not u.hostname:
        raise UserError('LLM 地址无效')
    if u.scheme!='https' and not (u.scheme=='http' and u.hostname in ('localhost','127.0.0.1','::1')):
        raise UserError('远程 LLM 必须使用 HTTPS')
    return base.rstrip('/') if u.path.rstrip('/').endswith('/chat/completions') else base.rstrip('/')+'/chat/completions'


def request(llm,messages,identity,existing,instructions='',system=SYSTEM):
    if not llm.get('key') or not llm.get('model'):
        raise UserError('请先保存 LLM API 密钥和模型')
    url=endpoint(llm['baseUrl'])
    # Short, request-local references avoid asking a model to transcribe opaque hashes.
    # Restore canonical references before any validation, storage or task import.
    message_refs={m['id']:'m'+str(i+1) for i,m in enumerate(messages)}
    task_refs={t['id']:'t'+str(i+1) for i,t in enumerate(existing)}
    wire_messages=[{**m,'id':message_refs[m['id']]} for m in messages]
    wire_existing=[{**t,'id':task_refs[t['id']]} for t in existing]
    payload={'model':llm['model'],'messages':[{'role':'system','content':system+'\n本次引用使用 m1、m2 等短编号，必须逐字复制 messages[].id，不要自行编造编号。\n用户本地规则：'+instructions}, {'role':'user','content':json.dumps({
        'today':datetime.now(TZ).date().isoformat(),'timezone':'Asia/Shanghai','user_identity':identity,
        'messages':wire_messages,'existing_tasks':wire_existing},ensure_ascii=False)}],
        'response_format':{'type':'json_object'},'temperature':llm.get('temperature',.2),'max_tokens':llm.get('feature_max_tokens',4096)}
    if llm.get('thinking')=='disabled':payload['thinking']={'type':'disabled'}
    # Existing provider name is not an inference of capabilities: supported protocol is explicit.
    for attempt in range(3):
        try:
            with httpx.Client(timeout=llm.get('timeout',60),follow_redirects=False,trust_env=urlparse(url).hostname not in ('localhost','127.0.0.1','::1')) as client:
                with client.stream('POST',url,headers={'Authorization':'Bearer '+llm['key']},json=payload) as response:
                    if response.status_code in (429,500,502,503,504) and attempt<2:
                        time.sleep(2**attempt); continue
                    if response.status_code!=200:
                        raise UserError(f'LLM 请求失败 HTTP {response.status_code}；已采集数据保留')
                    chunks=[]; count=0
                    for chunk in response.iter_bytes():
                        count+=len(chunk)
                        if count>1024*1024: raise UserError('LLM 响应超过限制')
                        chunks.append(chunk)
            value=json.loads(b''.join(chunks))
            choice=value['choices'][0]
            if choice.get('finish_reason')!='stop': raise UserError('模型输出未完整结束')
            raw=json.loads(choice['message']['content'])
            reverse_messages={v:k for k,v in message_refs.items()};reverse_tasks={v:k for k,v in task_refs.items()}
            def restore(value):
                if isinstance(value,list):return [restore(v) for v in value]
                if isinstance(value,dict):
                    result={k:restore(v) for k,v in value.items()}
                    if isinstance(value.get('source_ids'),list):result['source_ids']=[reverse_messages.get(v,v) if isinstance(v,str) else v for v in value['source_ids']]
                    if isinstance(value.get('message_id'),str):result['message_id']=reverse_messages.get(value['message_id'],value['message_id'])
                    if isinstance(value.get('existing_task_id'),str):result['existing_task_id']=reverse_tasks.get(value['existing_task_id'],value['existing_task_id'])
                    return result
                return value
            return restore(raw)
        except (httpx.HTTPError,KeyError,IndexError,TypeError,ValueError):
            if attempt==2: raise UserError('LLM 连接或结构化响应无效；未写入任务') from None
            time.sleep(2**attempt)


def checked_batch(raw,messages,existing,partial=False):
    """Strict grounding per item; a bad item never discards other grounded tasks."""
    if not partial:
        accepted,pending,notes=validate_proposals(raw,messages,existing)
        from group_confirmations import validate_useful
        useful_ids=validate_useful(raw.get('useful_information',[]),messages)
        return accepted,pending,notes,useful_ids,raw.get('useful_information',[]),'useful_information' in raw,False
    # Do not turn an unknown envelope or transport failure into an empty success.
    if not isinstance(raw,dict) or set(raw) not in ({'tasks','review_notes'},{'tasks','review_notes','useful_information'}) or not isinstance(raw.get('tasks'),list) or len(raw['tasks'])>100:
        raise UserError('模型输出不符合任务格式，未写入待办')
    validate_proposals({'tasks':[],'review_notes':raw.get('review_notes')},messages,existing)
    accepted=[];pending=[];notes=list(raw['review_notes']);invalid=False
    for candidate in raw['tasks']:
        try:
            good,review,_=validate_proposals({'tasks':[candidate],'review_notes':[]},messages,existing)
            accepted.extend(good);pending.extend(review)
        except UserError as error:
            invalid=True
            title=candidate.get('title') if isinstance(candidate,dict) else None
            label=('“'+title[:80]+'”') if isinstance(title,str) else '一条候选任务'
            notes.append(label+'需要人工核对：'+str(error)+'；未自动创建该任务')
    from group_confirmations import validate_useful
    useful_ids=set();useful=[]
    if not isinstance(raw.get('useful_information',[]),list):
        invalid=True;notes.append('重要信息格式无法核对，已保留现有结果')
    else:
        if len(raw.get('useful_information',[]))>100:
            invalid=True;notes.append('重要信息数量超过单批限制，保留可核对部分供人工确认')
        for item in raw.get('useful_information',[])[:100]:
            try:useful_ids.update(validate_useful([item],messages));useful.append(item)
            except UserError:invalid=True;notes.append('一条重要信息缺少可核对原文，未展示该信息')
    if invalid and not raw['tasks'] and not useful:
        raise UserError('重要信息缺少可核对的消息依据，未标记分析成功')
    return accepted,pending,notes,useful_ids,useful,'useful_information' in raw and not invalid,invalid


def input_message(m,scope):
    kind=m['message_type']
    if kind in (34,'audio','voice'):
        return {'id':m['id'],'group_id':m['chat_id'],'group_name':m['chat_name'],'timestamp':m['timestamp'],'sender':m['sender_name'],'type':kind,'text':'','truncated':False}
    # Media transport XML/JSON can contain CDN credentials; it is not message text.
    media_only=kind in (3,34,43,47,'image','audio','media','file','sticker')
    text=m['content'][:12000] if scope['text'] and not media_only else ''
    if kind not in (1,'text') and text.lstrip().startswith('<'):
        text='[结构化消息正文未解析，未发送原始传输 XML]'
    if kind=='post' and text.lstrip().startswith('{'):
        try:
            def collect(value):
                if isinstance(value,dict):
                    return [v for k,v in value.items() if k in ('text','title','href') and isinstance(v,str)]+[t for v in value.values() if isinstance(v,(dict,list)) for t in collect(v)]
                if isinstance(value,list):return [t for v in value for t in collect(v)]
                return []
            text='\n'.join(collect(json.loads(m['content'])))[:12000]
        except ValueError:text='[飞书富文本未成功解析]'
    truncated=m.get('truncated',False) or (scope['text'] and len(m['content'])>12000)
    for a in m['attachments']:
        permitted=(a['kind']=='document' and scope['documents']) or False or (a['kind']=='image' and scope.get('images',False))
        if permitted and a.get('extracted_text'):
            block=a['extracted_text'][:16000]
            text+='\n[附件 '+a.get('name',a['kind'])+']\n'+block
            truncated=truncated or a.get('truncated',False) or len(a['extracted_text'])>16000
            if a['kind']=='image' and a.get('vision_uncertainty'):
                text+='\n[视觉结果待核对] '+a['vision_uncertainty']
                truncated=True  # Existing proposal guard routes incomplete/uncertain sources to review.
    return {'id':m['id'],'group_id':m['chat_id'],'group_name':m['chat_name'],'timestamp':m['timestamp'],
            'sender':m['sender_name'],'type':m['message_type'],'text':text,'truncated':truncated}


def prepare(state,llm,existing,source_ids=None,selection=None):
    from summaries import validate_selection
    from progress import emit
    config=state.config()
    selection=validate_selection(selection or read_json(state.root/'config/summary.json',{}),allow_empty=True)
    targets={(v['source_id'],v['chat_id']) for v in selection['selected']}
    active={s['id'] for s in config['sources'] if s['enabled'] and (source_ids is None or s['id'] in source_ids)}
    with state.db() as con:
        for aid,payload in con.execute("SELECT id,payload FROM analyses WHERE status='ready' ORDER BY created").fetchall():
            body=json.loads(payload)
            refs=con.execute("SELECT id,source,chat,timestamp FROM messages WHERE json_extract(payload,'$.message_type') NOT IN (34,'audio','voice') AND id IN (SELECT key FROM json_each(?))",(json.dumps(body.get('revisions',{})),)).fetchall()
            if refs and len(refs)==len(body.get('revisions',{})) and all(r[1] in active and (r[1],r[2]) in targets and selection['since']<=r[3]<=selection['until'] for r in refs):return {'analysis_id':aid,**body}
    rules=read_json(state.root/'config/rules/analysis.json')
    if not isinstance(rules,dict) or set(rules)!={'version','exclude_senders','message_types','instructions'} or rules['version']!=1 or not isinstance(rules['instructions'],str) or len(rules['instructions'])>8000 or any(not isinstance(rules[k],list) for k in ('exclude_senders','message_types')):
        raise UserError('AI 业务规则文件无效')
    for source in config['sources']:
        if source['id'] not in active: continue
        scope={'text':True,'documents':True,'images':True}
        for sid,chat in sorted(targets):
            if sid!=source['id']:continue
            # Filter before batching so an empty/ignored prefix cannot starve later messages.
            with state.db() as con:
                rows=[]
                for (payload,) in con.execute("SELECT payload FROM messages WHERE source=? AND chat=? AND timestamp>=? AND timestamp<=? AND (analyzed IS NULL OR analyzed!=revision) AND json_extract(payload,'$.message_type') NOT IN (34,'audio','voice') ORDER BY timestamp,id",(source['id'],chat,selection['since'],selection['until'])):
                    m=json.loads(payload)
                    if m['sender_id'] in rules['exclude_senders'] or (rules['message_types'] and str(m['message_type']) not in [str(v) for v in rules['message_types']]):continue
                    if not input_message(m,scope)['text'].strip() and not m['attachments']:continue
                    rows.append(m)
                    if len(rows)>=40:break
            if not rows: continue
            if scope['images'] and llm.get('key'):
                from vision import describe
                for m in rows:
                    changed=False
                    for a in m['attachments']:
                        if a['kind']!='image' or not a.get('decoded_file') or a['stages'].get('vision') in ('ok','failed'):continue
                        try:
                            decoded=__import__('pathlib').Path(a['decoded_file']).resolve()
                            if not decoded.is_relative_to(state.root/'cache/attachments'):raise UserError('图片缓存路径无效')
                            result=describe(llm,decoded)
                            a['extracted_text']='[AI 视觉转录，须核对原图]\n'+result['text']+'\n'+result['description']
                            a['vision_uncertainty']=result['uncertainty'];a['stages']['vision']='ok'
                        except Exception as e:
                            a['stages']['vision']='failed';a['vision_error']=str(e)[:200] if isinstance(e,UserError) else type(e).__name__
                        changed=True
                    if changed:state.save_messages(source['id'],chat,[m],None)
            selected=[]; messages=[]; count=0
            for m in rows:
                if m['sender_id'] in rules['exclude_senders'] or (rules['message_types'] and str(m['message_type']) not in [str(v) for v in rules['message_types']]): continue
                item=input_message(m,scope)
                if not item['text'].strip() and not m['attachments']: continue
                cost=len(json.dumps(item,ensure_ascii=False))
                if selected and count+cost>60000: break
                count+=cost; selected.append(m); messages.append(item)
            if not messages: continue
            # Do not send descriptions/source evidence from other platforms, accounts or chats.
            related=[t for t in existing if t.get('sourceId')==source['id'] and t.get('groupId')==chat]
            related=[{k:v for k,v in t.items() if k in ('id','title','groupId','completed')} for t in related][:100]
            emit('请求 AI',len(messages),detail='等待模型返回任务分析')
            try:
                from feature_rules import settings as feature_settings
                feature=feature_settings(state)['tasks'];instructions=feature['instructions']
                task_llm={**llm,'feature_max_tokens':feature['max_tokens']}
                for attempt in range(2):
                    raw=request(task_llm,messages,config['identity'],related,instructions)
                    try:
                        accepted,pending,notes,useful_ids,useful,classified,needs_review=checked_batch(raw,messages,related)
                        break
                    except UserError as error:
                        if attempt:
                            accepted,pending,notes,useful_ids,useful,classified,needs_review=checked_batch(raw,messages,related,partial=True)
                            break
                        emit('请求 AI',len(messages),detail='正在修正任务来源引用，保留同一批已选消息')
                        instructions+='\n上次输出未通过任务核对：'+str(error)+'。请重新生成；source_ids 必须等于 evidence 中 message_id 的集合，每条 quote 只能复制一条消息的连续原文。不要列出没有引文的背景消息。无法核对的任务只写入 review_notes。'
            except Exception as e:
                from source_health import update
                update(state,source['id'],'analysis',False,str(e) if isinstance(e,UserError) else '消息分析异常')
                raise
            useful_ids.update(i for t in accepted for i in t['sourceIds'])
            useful_ids.update(i for t in pending for i in t['task']['sourceIds'])
            for item in accepted:
                item['key']=digest([source['id'],source['account_id'],item['key']])
                item.update(platform=source['platform'],sourceId=source['id'],accountId=source['account_id'])
                if source['platform']=='feishu': item['description']=item['description'].replace('微信来源：','飞书来源：')
                if source['platform']=='qq': item['description']=item['description'].replace('微信来源：','QQ来源：')
            revisions={m['id']:digest(m) for m in selected}
            result={'tasks':accepted,'pending':pending,'notes':notes,'revisions':revisions,'status':'ready','useful_ids':sorted(useful_ids),'usefulness_classified':classified,'useful_information':useful,'needs_review':needs_review}
            aid=digest([revisions,raw])
            with state.db() as con:
                con.execute('INSERT OR IGNORE INTO analyses VALUES(?,?,?,?)',(aid,'ready',json.dumps(result,ensure_ascii=False),time.time()))
            return {'analysis_id':aid,**result}
    return {'tasks':[],'status':'up_to_date'}


def acknowledge(state,analysis_id,results):
    with state.db() as con:
        row=con.execute("SELECT payload,status FROM analyses WHERE id=?",(analysis_id,)).fetchone()
        if not row: raise UserError('分析批次不存在')
        if row[1]!='ready': return {'status':'already_applied'}
        body=json.loads(row[0]); expected={t['key'] for t in body['tasks']}
        if not isinstance(results,list) or {r.get('key') for r in results}!=expected or any(r.get('status') not in ('imported','previously-imported','conflict','unchanged') for r in results):
            raise UserError('任务写入回执不完整，分析结果仍可重试')
        body['import_results']=results
        from group_confirmations import record
        record(con,body)
        con.execute("UPDATE analyses SET status='applied',payload=? WHERE id=?",(json.dumps(body,ensure_ascii=False),analysis_id))
        for mid,revision in body['revisions'].items():
            con.execute('UPDATE messages SET analyzed=? WHERE id=? AND revision=?',(revision,mid,revision))
        sources={r[0] for r in con.execute('SELECT DISTINCT source FROM messages WHERE id IN (SELECT key FROM json_each(?))',(json.dumps(body['revisions']),))}
    from source_health import update
    for sid in sources:update(state,sid,'analysis',True)
    return {'status':'applied','conflicts':sum(r['status']=='conflict' for r in results)}
