"""One request on stdin/stdout; chat content and credentials are never command arguments."""
import argparse
import json
import os
import sys
import time
from pathlib import Path

from state import State,FileLock,UserError,atomic_json,read_json,digest
from cache import Cache
from wechat import WeChat,import_keys,scan


def adapter(state,source):
    if source['platform']=='wechat': return WeChat(state,source)
    if source['platform']=='qq':
        from qq import QQ
        return QQ(state,source)
    from feishu import Feishu
    return Feishu(state,source)


def collect(state,source_ids=None,selection=None):
    from ws_workflow import collect_selected,saved_selection
    value=selection or saved_selection(state)
    if source_ids is not None:value={**value,'selected':[v for v in value['selected'] if v['source_id'] in source_ids]}
    return collect_selected(state,value,adapter)


def status(state):
    from feature_rules import settings as feature_settings,disclosure
    c=state.config()
    with state.db() as con:
        counts={'messages':con.execute('SELECT count(*) FROM messages').fetchone()[0],
                'pending_messages':con.execute('SELECT count(*) FROM messages WHERE analyzed IS NULL OR analyzed!=revision').fetchone()[0],
                'pending_imports':con.execute("SELECT count(*) FROM analyses WHERE status='ready'").fetchone()[0]}
        reviews=[]
        for (raw,) in con.execute('SELECT payload FROM analyses ORDER BY created DESC LIMIT 10'):
            body=json.loads(raw)
            reviews.extend(p['reason'] for p in body.get('pending',[]))
            reviews.extend(body.get('notes',[]))
            reviews.extend(r.get('reason','任务与用户编辑冲突，保留原任务') for r in body.get('import_results',[]) if r['status']=='conflict')
    from mcp_server import settings
    try:mcp_settings=settings(state)
    except UserError:mcp_settings=None
    sources=[]
    for s in c['sources']:
        try: secret=state.secret(('wechat-' if s['platform']=='wechat' else 'qq-' if s['platform']=='qq' else 'feishu-token-')+s['id']); valid=bool(secret)
        except UserError: valid=False
        sources.append({'id':s['id'],'platform':s['platform'],'has_credentials':valid,
                        'media_key':bool((state.root/'secrets'/('media-'+s['id']+'.dpapi')).exists()),
                        'health':read_json(state.root/('state/health-'+s['id']+'.json'),{}),
                        'connection':read_json(state.root/('state/connection-'+s['id']+'.json'),{})})
    return {'config':c,**counts,'review_notes':reviews[:30],'sources':sources,'cache':Cache(state,c['cache_limit_mb']).usage(),
            'qq_environment':{'prepared':(state.root/'qq/installation.json').is_file(),**read_json(state.root/'qq/installation.json',{})},
            'last_collection':read_json(state.root/'state/collection-status.json',{}),
            'analysis_prompt':read_json(state.root/'config/rules/analysis.json',{}).get('instructions',''),
            'ai_features':feature_settings(state),'ai_builtin':disclosure(),
            'mcp_settings':mcp_settings,'mcp_config':str(state.root/'config/mcp/server.json'),'rules':str(state.root/'config/rules/analysis.json')}


def dispatch(state,request):
    command=request.get('command')
    if command=='save_ai_features':
        from feature_rules import save
        return save(state,request.get('settings'))
    if command=='summary_options':
        from summaries import options
        return options(state,adapter)
    if command=='save_summary_selection':
        from ws_workflow import save_selection
        return save_selection(state,request['selection'])
    if command=='summary_generate':
        from summaries import generate
        return generate(state,request['selection'],request.get('llm',{}),adapter)
    if command=='enrich_images':
        from ws_workflow import enrich_images
        return enrich_images(state,request['selection'],request['llm'])
    if command=='status': return status(state)
    if command=='begin_qq_switch':
        from qq_accounts import begin_switch
        return begin_switch(state,request['source_id'])
    if command=='group_confirmations':
        from group_confirmations import decisions
        return decisions(state,request['selection'])
    if command=='prepare_qq':
        from qq_setup import prepare
        return prepare(state,request['archive'],request['path'])
    if command=='save_analysis_prompt':
        text=request.get('prompt')
        if not isinstance(text,str) or len(text)>8000:raise UserError('高级提示词最多 8000 字符')
        file=state.root/'config/rules/analysis.json';rules=read_json(file)
        if not isinstance(rules,dict) or set(rules)!={'version','exclude_senders','message_types','instructions'} or rules['version']!=1:raise UserError('现有分析规则无效，请先修复规则文件')
        atomic_json(state.root/'backups'/('analysis-rules-'+str(time.time_ns())+'.json'),rules)
        rules['instructions']=text;atomic_json(file,rules)
        return {'saved':True}
    if command=='save_config':
        from source_config import save
        save(state,request['config'])
        return status(state)
    if command=='discover':
        from common import discover
        return {'directories':discover()}
    if command=='collect': return collect(state,request.get('source_ids'),request.get('selection'))
    if command=='clean_cache': return Cache(state,state.config()['cache_limit_mb']).clean(all_unused=True)
    if command=='prepare':
        from analysis import prepare
        with FileLock(state.root/'state/analysis.lock',blocking=False):
            return prepare(state,request.get('llm',{}),request.get('existing',[]),request.get('source_ids'),request.get('selection'))
    if command=='ack':
        from analysis import acknowledge
        return acknowledge(state,request['analysis_id'],request['results'])
    if command=='validate_transfer':
        import sqlite3
        root=Path(request['path']);manifest=read_json(root/'manifest.json')
        if not isinstance(manifest,dict) or manifest.get('format')!='WS-PRIVATE-MIGRATION' or manifest.get('version')!=1:raise UserError('迁移包版本无效')
        if (root/'content/config/integration.json').exists():state.validate_config(read_json(root/'content/config/integration.json'))
        db=root/'content/databases/messages.sqlite3'
        if db.exists():
            con=sqlite3.connect(db.resolve().as_uri()+'?mode=ro&immutable=1',uri=True)
            try:
                if con.execute('PRAGMA user_version').fetchone()[0]!=1 or con.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise UserError('消息历史版本不兼容或完整性校验失败')
            finally:con.close()
        return {'valid':True}
    if command=='validate_mcp':
        from mcp_server import settings
        return settings(state)
    if command=='save_mcp':
        from mcp_server import validate_settings
        value=validate_settings(request['config'])
        atomic_json(state.root/'config/mcp/server.json',value)
        return value
    source=next((s for s in state.config()['sources'] if s['id']==request.get('source_id')),None)
    if not source: raise UserError('数据源不存在')
    if command in ('test_source','connect_source'):
        from connections import connect
        return connect(state,source,repair=command=='connect_source')
    if command=='clear_credentials':
        for prefix in ('wechat-','media-','feishu-app-','feishu-token-'):
            (state.root/'secrets'/(prefix+source['id']+'.dpapi')).unlink(missing_ok=True)
        return {'cleared':True,'tasks':'preserved','history':'preserved'}
    if command=='delete_history':
        import sqlite3
        backup=state.root/'backups'/('history-'+str(time.time_ns())+'.sqlite3')
        with state.db() as con:
            target=sqlite3.connect(backup)
            try:con.backup(target)
            finally:target.close()
            ids={r[0] for r in con.execute('SELECT id FROM messages WHERE source=?',(source['id'],))}
            for aid,raw in con.execute('SELECT id,payload FROM analyses').fetchall():
                if ids.intersection(json.loads(raw).get('revisions',{})):con.execute('DELETE FROM analyses WHERE id=?',(aid,))
            con.execute('DELETE FROM message_receipts WHERE message IN (SELECT id FROM messages WHERE source=?)',(source['id'],))
            con.execute('DELETE FROM messages WHERE source=?',(source['id'],))
            con.execute('DELETE FROM cursors WHERE source=?',(source['id'],))
        return {'deleted_messages':len(ids),'tasks':'preserved','credentials':'preserved','backup':str(backup)}
    if command=='groups':
        reader=adapter(state,source)
        return {'groups':reader.conversations() if hasattr(reader,'conversations') else reader.groups()}
    if command=='scan': return scan(state,source)
    if command=='scan_media':
        from media_keys import scan as scan_media
        return scan_media(state,source)
    if command=='import_keys': return import_keys(state,source,request['path'])
    if command=='media_key':
        value=request['value']
        key=bytes.fromhex(value.get('aes_key',''))
        if len(key)!=16 or type(value.get('xor_key')) is not int or not 0<=value['xor_key']<=255:
            raise UserError('图片密钥应为 16 字节 AES 和 0–255 XOR')
        state.secret('media-'+source['id'],value,write=True); return {'saved':True}
    if command=='import_feishu':
        from connections import import_feishu
        return import_feishu(state,source,request['path'])
    raise UserError('不支持的消息操作')


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--data')
    parser.add_argument('--mcp',action='store_true')
    args=parser.parse_args()
    program=Path(sys.executable).resolve().parents[2] if getattr(sys,'frozen',False) else Path(__file__).resolve().parents[1]
    chosen=args.data or os.environ.get('WS_PRIVATE_ROOT') or str(program/'WS-Private')
    if not Path(chosen).is_absolute():raise UserError('PrivateRoot 必须为绝对目录')
    state=State(chosen)
    if args.mcp:
        from mcp_server import serve
        serve(state); return
    raw=sys.stdin.buffer.read(4*1024*1024+1)
    run_id=None
    try:
        if len(raw)>4*1024*1024: raise UserError('请求超过限制')
        request=json.loads(raw)
        if request.get('command') in ('collect','prepare','ack','scan','scan_media'):
            with state.db() as con:
                run_id=con.execute('INSERT INTO runs(started,stage,status,detail) VALUES(?,?,?,?)',(time.time(),request['command'],'running','')).lastrowid
        result=dispatch(state,request)
        response={'ok':True,'value':result}
    except Exception as e:
        response={'ok':False,'error':str(e)[:300] if isinstance(e,UserError) else '消息处理失败：'+type(e).__name__}
    if run_id is not None:
        with state.db() as con:
            con.execute('UPDATE runs SET finished=?,status=?,detail=? WHERE id=?',(time.time(),'ok' if response['ok'] else 'failed','' if response['ok'] else response['error'],run_id))
    sys.stdout.buffer.write((json.dumps(response,ensure_ascii=False)+'\n').encode('utf-8'))


if __name__=='__main__': main()
