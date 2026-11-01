import json, os, tempfile, unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from state import State, atomic_json, UserError
import feishu_daily as daily

def ts(day, hour=0, minute=0, second=0):
    return int(datetime.fromisoformat(day).replace(hour=hour, minute=minute, second=second).timestamp())

def message(mid, day, hour, chat='oc_test', text=None):
    return {'id': mid, 'chat_id': chat, 'chat_name': '课程群', 'message_id': 'om_'+mid,
        'sender_name': '同学', 'timestamp': ts(day,hour), 'content': text or '周五交报告 '+mid,
        'message_type': 'text', 'attachments': [], 'raw_reference': {}}

class Reader:
    source={'account_id':'user'}
    def __init__(self): self.messages=[];self.reads=[];self.fail=None
    async def verify_account(self): pass
    def iter_messages(self, chat, since, until):
        self.reads.append((chat,since,until))
        for m in self.messages:
            if m['chat_id']==chat and since<=m['timestamp']<=until:
                yield m
                if self.fail:raise self.fail
        if self.fail:raise self.fail

def answer(llm, messages, *args, **kwargs):
    result={k:[] for k in daily.SECTIONS}
    result['topics']=[{'text':'报告安排：'+str(len(messages))+'条来源', 'source_ids':[m['id'] for m in messages], 'quote':messages[0]['text'][:30]}]
    return result

class Daily(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir=os.environ.get('WS_TEST_TMP'))
        self.state=State(Path(self.tmp.name)/'private');self.reader=Reader()
        self.cfg={'version':1,'enabled':True,'daily_time':'21:00','groups':[{'id':'oc_test','name':'课程群','start_date':'2026-11-01'}], 'source':{'id':'feishu-daily','account_id':'user','account_name':'本人'}}
        self.write()
        self.p=patch('feishu_daily.reader',return_value=self.reader);self.p.start()
        self.ai=patch('analysis.request',side_effect=answer);self.model=self.ai.start()
    def tearDown(self):
        self.ai.stop();self.p.stop();self.tmp.cleanup()
    def write(self):atomic_json(self.state.root/'config/feishu-daily.json',self.cfg)
    def run_at(self,day,hour=21,scheduled=False):return daily.run(self.state,{},ts(day,hour),scheduled)
    def rows(self):return daily.status(self.state)['history']
    def test_natural_day_backfill_updates_same_record_and_preserves_tasks(self):
        task=self.state.root/'tasks/keep.json';task.parent.mkdir();task.write_text('keep')
        self.reader.messages=[message('one','2026-11-01',10),message('late','2026-11-01',22),message('today','2026-11-02',13)]
        self.run_at('2026-11-01');self.assertEqual(self.rows()[0]['count'],1);self.assertFalse(self.rows()[0]['complete'])
        self.run_at('2026-11-02');rows=self.rows()
        self.assertEqual(len(rows),2);self.assertEqual(rows[1]['day'],'2026-11-01');self.assertEqual(rows[1]['count'],2)
        self.assertTrue(rows[1]['complete']);self.assertEqual(self.model.call_count,3)
        self.assertEqual(task.read_text(),'keep')
        with daily.closing(daily.db(self.state)) as con:
            self.assertEqual(con.execute("SELECT count(*) FROM raw_messages WHERE day='2026-11-01'").fetchone()[0],0)
        self.run_at('2026-11-02');self.assertEqual(self.model.call_count,3)
    def test_no_late_messages_finalizes_without_llm_and_restart_does_not_reanalyze(self):
        self.reader.messages=[message('one','2026-11-01',10)]
        self.run_at('2026-11-01');self.run_at('2026-11-02');self.assertEqual(self.model.call_count,1)
        self.state=State(self.state.root);self.run_at('2026-11-02');self.assertEqual(self.model.call_count,1)
        self.assertTrue(self.rows()[1]['complete'])
    def test_time_change_and_multiple_missed_days_are_separate(self):
        self.reader.messages=[message('one','2026-11-01',9),message('late','2026-11-01',23),message('two','2026-11-02',14),message('three','2026-11-03',14)]
        self.run_at('2026-11-01',10)
        self.cfg['daily_time']='08:00';self.write();self.run_at('2026-11-04',9,True)
        rows=self.rows();self.assertEqual(len(rows),4)
        self.assertEqual([(r['day'],r['count']) for r in reversed(rows)],[('2026-11-01',2),('2026-11-02',1),('2026-11-03',1),('2026-11-04',0)])
    def test_before_schedule_catches_up_yesterday_but_does_not_summarize_today(self):
        self.run_at('2026-11-03',8,True)
        self.assertEqual([r['day'] for r in self.rows()],['2026-11-02','2026-11-01']);self.model.assert_not_called()
    def test_ai_failure_retains_old_summary_and_retries_collected_data(self):
        self.reader.messages=[message('one','2026-11-01',10),message('late','2026-11-01',22)]
        self.run_at('2026-11-01');old=self.rows()[0]['summary']
        self.model.side_effect=UserError('模拟服务暂不可用')
        result=self.run_at('2026-11-02');self.assertFalse(result['ok']);self.assertEqual(self.rows()[0]['summary'],old)
        reads=len(self.reader.reads);self.model.side_effect=answer;self.run_at('2026-11-02')
        self.assertEqual(self.rows()[1]['count'],2);self.assertFalse(self.rows()[1]['error'])
        self.assertEqual(len(self.reader.reads),reads+1) # Only the new day needs acquisition.
    def test_partial_collection_rolls_back_cursor_and_other_groups_continue(self):
        self.cfg['groups'].append({'id':'oc_other','name':'另一群','start_date':'2026-11-01'});self.write()
        self.reader.messages=[message('one','2026-11-01',10),message('other','2026-11-01',10,'oc_other')]
        original=self.reader.iter_messages
        def broken(chat,since,until):
            yield from original(chat,since,until)
            if chat=='oc_test':raise UserError('模拟第二页断网')
        self.reader.iter_messages=broken
        result=self.run_at('2026-11-01');self.assertFalse(result['ok'])
        rows={r['chat']:r for r in self.rows()};self.assertEqual(rows['oc_test']['collected_until'],ts('2026-11-01'))
        self.assertIsNone(rows['oc_test']['summary']);self.assertIsNotNone(rows['oc_other']['summary'])
        self.reader.iter_messages=original;self.run_at('2026-11-01');self.assertEqual({r['chat']:r['count'] for r in self.rows()},{'oc_test':1,'oc_other':1})
    def test_midnight_is_not_assigned_to_previous_day_and_duplicate_ids_are_deduped(self):
        m=message('one','2026-11-01',10)
        self.reader.messages=[m,m,message('midnight','2026-11-02',0)]
        self.run_at('2026-11-02',1)
        self.assertEqual({r['day']:r['count'] for r in self.rows()},{'2026-11-01':1,'2026-11-02':1})
    def test_unparsed_media_is_marked_and_empty_day_does_not_call_llm(self):
        m=message('audio','2026-11-01',10);m.update(message_type='audio',attachments=[{'kind':'audio'}])
        self.reader.messages=[m];self.run_at('2026-11-02')
        self.model.assert_not_called();self.assertTrue(self.rows()[1]['summary']['missing'])
    def test_fabricated_quote_is_rejected_and_old_content_remains(self):
        self.reader.messages=[message('one','2026-11-01',10)]
        self.model.side_effect=lambda *a,**kw:{**{k:[] for k in daily.SECTIONS},'topics':[{'text':'假内容','source_ids':['one'],'quote':'原文没有这段'}]}
        result=self.run_at('2026-11-01');self.assertFalse(result['ok']);self.assertIsNone(self.rows()[0]['summary']);self.assertEqual(self.model.call_count,2)
    def test_large_day_uses_bounded_batches_and_reduces_verified_evidence(self):
        self.reader.messages=[message(str(i),'2026-11-01',10,text='报告安排 '+str(i)+'。'+'讨论内容'*90) for i in range(250)]
        self.run_at('2026-11-01');self.assertGreater(self.model.call_count,4)
        self.assertEqual(self.rows()[0]['count'],250);self.assertIsNotNone(self.rows()[0]['summary'])
        self.assertTrue(all(len(json.dumps(call.args[1],ensure_ascii=False))<=100000 for call in self.model.call_args_list))
    def test_reselected_group_keeps_original_archive_start(self):
        value=daily.save(self.state,{'enabled':True,'daily_time':'09:30','groups':[{'id':'oc_test','name':'改名群'}]})
        self.assertEqual(value['groups'][0]['start_date'],'2026-11-01')
        self.assertEqual(value['groups'][0]['id'],'oc_test')
    def test_history_pagination_and_account_isolation(self):
        self.reader.messages=[message('one','2026-11-01',10)];self.run_at('2026-11-01')
        self.reader.source={'account_id':'other'};self.cfg['source']['account_id']='other';self.write();self.run_at('2026-11-01')
        self.assertEqual(len(self.rows()),2)
        self.assertEqual(len(daily.status(self.state,1)['history']),1)
        with self.assertRaises(UserError):daily.status(self.state,-1)

class ThreadPages(unittest.TestCase):
    def test_old_root_new_reply_and_full_thread_pagination(self):
        from feishu import Feishu
        from feishu_mcp.feishu import normalize_message
        from unittest.mock import AsyncMock
        r=Feishu.__new__(Feishu);r.source={'id':'daily','account_id':'user'}
        r.verify_account=AsyncMock()
        def raw(mid,day,hour,thread='',parent=''):
            return {'message_id':mid,'chat_id':'oc_test','msg_type':'text','create_time':str(ts(day,hour)*1000),
                    'sender':{'id':'user'},'body':{'content':json.dumps({'text':'回复 '+mid})},'thread_id':thread,'parent_id':parent}
        root=normalize_message(raw('root','2026-10-01',8,'omt_old'))
        async def history(chat,*args,**kwargs):
            return {'messages':[] if args else [root], 'has_more':False,'next_page_token':''}
        async def thread(method,path,params):
            self.assertEqual(params['container_id_type'],'thread')
            self.assertNotIn('start_time',params)
            if not params.get('page_token'):
                return {'items':[raw('r1','2026-11-01',12,'omt_old','root')],'has_more':True,'page_token':'p2'}
            return {'items':[raw('r2','2026-11-01',10,'omt_old','root'),raw('root','2026-10-01',8,'omt_old')],'has_more':False}
        r.client=type('Client',(),{})();r.client.list_messages=AsyncMock(side_effect=history);r.client._request_json=AsyncMock(side_effect=thread)
        values=list(r.iter_daily_messages('oc_test',ts('2026-11-01'),ts('2026-11-02')))
        self.assertEqual({m['message_id'] for m in values},{'r1','r2'})
        self.assertEqual(r.client._request_json.await_count,2)
        self.assertTrue(all(m['raw_reference']['thread_id']=='omt_old' and m['reply_to']=='root' for m in values))

    def test_cyclic_chat_page_token_fails_instead_of_claiming_complete(self):
        from feishu import Feishu
        from unittest.mock import AsyncMock
        r=Feishu.__new__(Feishu);r.source={'id':'daily','account_id':'user'};r.verify_account=AsyncMock()
        r.client=type('Client',(),{})()
        r.client.list_messages=AsyncMock(return_value={'messages':[],'has_more':True,'next_page_token':'same'})
        with self.assertRaises(UserError):list(r.iter_daily_messages('oc_test',1,10))

if __name__=='__main__':unittest.main()
