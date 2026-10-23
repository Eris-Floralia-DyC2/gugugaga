"""Portable state and current-user DPAPI secrets. Never open a source for writing."""
import base64
import contextlib
import hashlib
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / 'vendor'))
from common import atomic_json, dpapi, UserError


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def read_json(path, default=None):
    path = Path(path)
    return json.loads(path.read_text(encoding='utf-8-sig')) if path.exists() else default


class FileLock:
    """OS releases leases on crash; the lock file itself contains no credentials."""
    def __init__(self, path, blocking=True):
        self.path, self.blocking = Path(path), blocking

    def __enter__(self):
        import msvcrt
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.file = self.path.open('x+b')
            self.file.write(b'0')
            self.file.flush()
        except FileExistsError:
            self.file = self.path.open('r+b')
        deadline = time.monotonic() + (300 if self.blocking else 0)
        while True:
            try:
                self.file.seek(0)
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
                return self
            except OSError:
                if time.monotonic() >= deadline:
                    self.file.close()
                    raise UserError('对应数据正在使用，请稍后重试') from None
                time.sleep(.1)

    def __exit__(self, *args):
        import msvcrt
        self.file.seek(0)
        msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
        self.file.close()


class State:
    def __init__(self, root):
        self.root = Path(root).resolve()
        os.environ['WS_PRIVATE_ROOT']=str(self.root)
        scratch=self.root/'temp';scratch.mkdir(parents=True,exist_ok=True)
        os.environ['TEMP']=os.environ['TMP']=os.environ['TMPDIR']=str(scratch)
        for key,relative in {'HF_HOME':'cache/huggingface','HF_HUB_CACHE':'cache/huggingface/hub',
                             'HF_XET_CACHE':'cache/huggingface/xet','XET_LOG_DIR':'logs/xet',
                             'XDG_CACHE_HOME':'cache/libraries','TORCH_HOME':'cache/torch'}.items():
            folder=self.root/relative;folder.mkdir(parents=True,exist_ok=True);os.environ[key]=str(folder)
        __import__('tempfile').tempdir=str(scratch)
        self.config_file = self.root / 'config' / 'integration.json'
        for p in ('secrets', 'databases', 'cache/decrypted', 'cache/attachments', 'config/mcp', 'config/rules', 'logs'):
            (self.root / p).mkdir(parents=True, exist_ok=True)
        self.dbfile = self.root / 'databases' / 'messages.sqlite3'
        with self.db() as con:
            if con.execute('PRAGMA user_version').fetchone()[0]>1:
                raise UserError('消息数据库版本较新，请使用兼容版本，原数据未改动')
            con.executescript('''
            CREATE TABLE IF NOT EXISTS messages (
              id TEXT PRIMARY KEY, source TEXT NOT NULL, chat TEXT NOT NULL,
              timestamp INTEGER NOT NULL, payload TEXT NOT NULL, revision TEXT NOT NULL,
              analyzed TEXT, saved_at REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS msg_query ON messages(source,chat,timestamp);
            CREATE TABLE IF NOT EXISTS cursors (source TEXT, chat TEXT, until INTEGER,
              PRIMARY KEY(source,chat));
            CREATE TABLE IF NOT EXISTS bindings (source TEXT,chat TEXT,value TEXT,PRIMARY KEY(source,chat));
            CREATE TABLE IF NOT EXISTS analyses (id TEXT PRIMARY KEY, status TEXT,
              payload TEXT NOT NULL, created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, started REAL,
              finished REAL, stage TEXT, status TEXT, detail TEXT);
            CREATE TABLE IF NOT EXISTS schedule (day TEXT PRIMARY KEY, finished REAL);
            CREATE TABLE IF NOT EXISTS message_receipts (message TEXT, revision TEXT, useful INTEGER NOT NULL,
              finished REAL NOT NULL, PRIMARY KEY(message,revision));
            PRAGMA user_version=1;
            ''')
        rules=self.root/'config/rules/analysis.json'
        if not rules.exists():
            atomic_json(rules,{'version':1,'exclude_senders':[],'message_types':[],
                               'instructions':'只提取有原文依据、适用于用户的明确任务；保留未确定的日期，不编造。'})
        self.rebase()

    def rebase(self):
        marker=self.root/'state/storage-origin.json'
        imported=read_json(self.root/'state/import-origin.json',{})
        old=imported.get('origin') or read_json(marker,{}).get('root')
        def convert(value):
            if isinstance(value,str) and old and (value==old or value.startswith(old+'\\') or value.startswith(old+'/')):
                return str(self.root)+value[len(old):]
            if isinstance(value,dict):return {k:convert(v) for k,v in value.items()}
            if isinstance(value,list):return [convert(v) for v in value]
            return value
        if old and str(self.root)!=old:
            with self.db() as con:
                for table in ('messages','analyses'):
                    for key,raw in con.execute(f'SELECT id,payload FROM {table}').fetchall():
                        body=convert(json.loads(raw));new=json.dumps(body,ensure_ascii=False,sort_keys=True)
                        if table=='messages':
                            revision=digest(body)
                            con.execute('UPDATE OR IGNORE message_receipts SET revision=? WHERE message=? AND revision=?',(revision,key,digest(json.loads(raw))))
                            con.execute('UPDATE messages SET payload=?,revision=?,analyzed=CASE WHEN analyzed IS NOT NULL THEN ? ELSE NULL END WHERE id=?',(new,revision,revision,key))
                        else:
                            if isinstance(body.get('revisions'),dict):
                                for mid in body['revisions']:
                                    current=con.execute('SELECT revision FROM messages WHERE id=?',(mid,)).fetchone()
                                    if current:body['revisions'][mid]=current[0]
                                new=json.dumps(body,ensure_ascii=False,sort_keys=True)
                            con.execute('UPDATE analyses SET payload=? WHERE id=?',(new,key))
        atomic_json(marker,{'version':1,'root':str(self.root)})
        (self.root/'state/import-origin.json').unlink(missing_ok=True)

    @contextlib.contextmanager
    def db(self):
        conn = sqlite3.connect(self.dbfile, timeout=30)
        try:
            conn.execute('PRAGMA foreign_keys=ON')
            conn.execute('PRAGMA synchronous=FULL')
            with conn:
                yield conn
        finally:
            conn.close()

    def config(self):
        raw=read_json(self.config_file, {
            'version':3,'sources':[],'enabled':False,'daily_time':'20:00','initial_days':7,'lookback_days':7,'cache_limit_mb':2048,'identity':'','schedule_action':'tasks',
        })
        result=self.validate_config(raw)
        if raw.get('version') in (1,2) and self.config_file.exists():
            backup=self.root/('backups/integration-v'+str(raw['version'])+'-before-v3.json')
            if not backup.exists():atomic_json(backup,raw)
            # Keep the explicitly saved selection. Only fall back to old targets if none exists.
            selection=self.root/'config/summary.json'
            if not selection.exists():
                targets=[{'source_id':s['id'],'chat_id':g} for s in raw['sources'] for g in s.get('groups',[])][:20]
                now=int(time.time());atomic_json(selection,{'version':1,'selected':targets,'since':now-result['initial_days']*86400,'until':now})
            atomic_json(self.config_file,result)
        return result

    @staticmethod
    def validate_config(c):
        from source_config import validate
        return validate(c)

    def secret(self, name, value=None, write=False):
        import re
        if not re.fullmatch('[a-zA-Z0-9_-]{1,120}', name):
            raise UserError('凭据名称无效')
        path = self.root / 'secrets' / (name + '.dpapi')
        if write:
            atomic_json(path, {'version':1, 'ciphertext':base64.b64encode(dpapi(json.dumps(value).encode())).decode()})
            return
        raw = read_json(path)
        if raw is None:
            return None
        return json.loads(dpapi(base64.b64decode(raw['ciphertext']), True))

    def save_messages(self, source, chat, messages, until):
        # Cursor and all normalized messages commit together, before any LLM request.
        from schemas import Message
        with self.db() as con:
            for m in messages:
                m=Message.model_validate(m).model_dump(mode='json')
                if m['source_id']!=source or m['chat_id']!=chat:
                    raise UserError('消息来源与采集范围不一致')
                raw = json.dumps(m, ensure_ascii=False, sort_keys=True)
                con.execute('''INSERT INTO messages VALUES(?,?,?,?,?,?,NULL,?)
                  ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,revision=excluded.revision,
                  analyzed=messages.analyzed''',
                  (m['id'],source,chat,m['timestamp'],raw,digest(m),time.time()))
            if until is not None:
                con.execute('INSERT INTO cursors VALUES(?,?,?) ON CONFLICT(source,chat) DO UPDATE SET until=MAX(until,excluded.until)', (source,chat,until))

    def messages(self, source=None, chat=None, since=0, until=253402300799, limit=200, pending=False):
        if type(limit) is not int or not 1 <= limit <= 200:
            raise UserError('查询每页限 1–200 条')
        query, args = 'SELECT payload FROM messages WHERE timestamp>=? AND timestamp<=?', [since,until]
        if source:
            query += ' AND source=?'; args.append(source)
        if chat:
            query += ' AND chat=?'; args.append(chat)
        if pending:
            query += " AND (analyzed IS NULL OR analyzed!=revision) AND json_extract(payload,'$.message_type') NOT IN (34,'audio','voice')"
        with self.db() as con:
            return [json.loads(r[0]) for r in con.execute(query+' ORDER BY timestamp,id LIMIT ?',args+[limit])]
