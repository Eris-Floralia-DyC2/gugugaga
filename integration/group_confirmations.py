"""Group/day decisions from collected evidence and successful revision receipts only."""
import hashlib
import json
from datetime import datetime, timezone, timedelta
from state import read_json
from source_config import account_key

TZ = timezone(timedelta(hours=8))  # WS currently supports Asia/Shanghai only.


def validate_useful(items, messages):
    from state import UserError
    known = {m['id']: m for m in messages}
    ids = set()
    if not isinstance(items, list) or len(items) > 100:
        raise UserError('有用信息分析结构无效，未标记分析成功')
    for item in items:
        if (not isinstance(item, dict) or set(item) != {'text', 'source_ids', 'quote'}
                or not isinstance(item['text'], str) or not 1 <= len(item['text']) <= 4000
                or not isinstance(item['source_ids'], list) or not 1 <= len(item['source_ids']) <= 30
                or any(not isinstance(i, str) or i not in known for i in item['source_ids'])
                or not isinstance(item['quote'], str) or not 2 <= len(item['quote']) <= 2000
                or not any(item['quote'] in known[i]['text'] for i in item['source_ids'])):
            raise UserError('有用信息缺少可核对的消息依据，未标记分析成功')
        ids.update(item['source_ids'])
    return ids


def key_for(platform, account, chat, day):
    raw = json.dumps([platform, account_key(platform, account), chat, day], ensure_ascii=False, separators=(',', ':'))
    return hashlib.sha256(raw.encode()).hexdigest()


def incomplete(message):
    if message.get('truncated'):
        return True
    for a in message.get('attachments', []):
        stages = a.get('stages', {})
        if a.get('error') or a.get('truncated') or a.get('vision_uncertainty'):
            return True
        stage = {'document': 'extracted', 'image': 'vision', 'audio': 'transcribed'}.get(a['kind'])
        if not stage or stages.get(stage) != 'ok' or not a.get('extracted_text', '').strip():
            return True
        if a.get('resolution') == 'thumbnail':
            return True
    return False


def record(con, body):
    useful = set(body.get('useful_ids', [i for t in body.get('tasks', []) for i in t.get('sourceIds', [])]))
    for mid, revision in body['revisions'].items():
        if not body.get('usefulness_classified','useful_ids' in body) and mid not in useful:
            continue  # Older task-only outputs cannot classify notices/conclusions as useless.
        con.execute('INSERT INTO message_receipts VALUES(?,?,?,?) ON CONFLICT(message,revision) DO UPDATE SET useful=MAX(useful,excluded.useful)',
                    (mid, revision, int(mid in useful), __import__('time').time()))


def decisions(state, selection, now=None):
    today = (now or datetime.now(TZ)).astimezone(TZ).date().isoformat()
    sources = {s['id']: s for s in state.config()['sources'] if s['enabled']}
    directory = read_json(state.root/'config/conversation-directory.json', {'conversations': []})
    chats = {(r['source_id'], r['chat_id']): r for r in directory['conversations']}
    ledger = read_json(state.root/'state/group-confirmations.json', {})
    output = []
    for target in selection['selected']:
        sid, chat = target['source_id'], target['chat_id']
        s = sources.get(sid)
        if not s or s['platform'] not in ('wechat', 'qq'):
            continue
        meta = chats.get((sid, chat), {})
        is_group = meta.get('kind') == 'group' or (s['platform'] == 'wechat' and chat.endswith('@chatroom')) or (s['platform'] == 'qq' and chat.startswith('group:'))
        if not is_group:
            continue
        days = {today} | {v['day'] for v in ledger.values() if v.get('platform') == s['platform'] and v.get('accountId') == account_key(s['platform'], s['account_id']) and v.get('groupId') == chat and v.get('state') != 'completed'}
        for day in sorted(days):
            start = int(datetime.fromisoformat(day).replace(tzinfo=TZ).timestamp())
            with state.db() as con:
                rows = con.execute('SELECT id,payload,revision FROM messages WHERE source=? AND chat=? AND timestamp>=? AND timestamp<? ORDER BY timestamp,id', (sid, chat, start, start+86400)).fetchall()
                if not rows:
                    continue
                # Account/source replacement cannot reuse another account's indexed messages.
                rows = [r for r in rows if account_key(s['platform'], json.loads(r[1])['account_id']) == account_key(s['platform'], s['account_id'])]
                if not rows:
                    continue
                broken = any(incomplete(json.loads(r[1])) for r in rows)
                complete = all(con.execute('SELECT 1 FROM message_receipts WHERE message=? AND revision=?', (r[0], r[2])).fetchone() for r in rows)
                useful = any(con.execute('SELECT 1 FROM message_receipts WHERE message=? AND useful=1', (r[0],)).fetchone() for r in rows)
            # Unknown/failed LLM status never means "no useful information".
            collection = read_json(state.root/'state/collection-status.json', {})
            failed = any(e.get('source') == sid and e.get('chat') == chat for e in collection.get('errors', []))
            needed = True if broken else (not useful if complete and not failed else None)
            if needed is None:
                continue
            name = meta.get('name') or json.loads(rows[-1][1])['chat_name']
            output.append({'key': key_for(s['platform'], s['account_id'], chat, day), 'platform': s['platform'],
                           'accountId': account_key(s['platform'], s['account_id']), 'sourceId': sid,
                           'groupId': chat, 'name': name, 'day': day, 'needed': needed,
                           'incomplete': broken, 'useful': useful, 'analysisComplete': complete})
    return output
