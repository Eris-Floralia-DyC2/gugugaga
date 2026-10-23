import json, os, tempfile, unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from state import State, atomic_json, digest, UserError
from test_integration import message
from source_config import save
from group_confirmations import decisions, incomplete, TZ
from analysis import prepare, acknowledge

NOW=datetime(2026,10,22,12,tzinfo=TZ)
STAMP=int(NOW.timestamp())


class GroupConfirmations(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=os.environ['WS_TEST_TMP'])
        self.s=State(Path(self.temp.name)/'private')
        c=self.s.config();c['sources']=[{'id':'s','platform':'wechat','account_id':'a','account_name':'测试','db_dir':'','enabled':True}];save(self.s,c)
        atomic_json(self.s.root/'config/conversation-directory.json',{'conversations':[{'source_id':'s','chat_id':'chat','name':'测试群','kind':'group'}]})
        self.pick={'version':1,'selected':[{'source_id':'s','chat_id':'chat'}],'since':STAMP-86400,'until':STAMP+86400}
    def tearDown(self):self.temp.cleanup()
    def add(self,mid='one',**kwargs):
        m={**message(mid,content='课程通知：明天补课'), 'timestamp':STAMP,**kwargs}
        self.s.save_messages('s','chat',[m],STAMP);return m
    def decide(self):return decisions(self.s,self.pick,NOW)
    def analyze(self,raw=None):
        with patch('analysis.request',return_value=raw or {'tasks':[],'review_notes':[],'useful_information':[]}):r=prepare(self.s,{},[],selection=self.pick)
        if 'analysis_id' in r:acknowledge(self.s,r['analysis_id'],[])
        return r
    def test_no_messages_never_creates_confirmation(self):self.assertEqual(self.decide(),[])
    def test_unanalyzed_and_llm_failure_do_not_mean_empty_success(self):
        self.add();self.assertEqual(self.decide(),[])
        with patch('analysis.request',side_effect=UserError('LLM 请求失败 HTTP 401')):
            with self.assertRaises(UserError):prepare(self.s,{},[],selection=self.pick)
        self.assertEqual(self.decide(),[])
    def test_successful_empty_analysis_requires_complete_ack(self):
        self.add()
        with patch('analysis.request',return_value={'tasks':[],'review_notes':[],'useful_information':[]}):r=prepare(self.s,{},[],selection=self.pick)
        self.assertEqual(self.decide(),[])
        acknowledge(self.s,r['analysis_id'],[])
        self.assertTrue(self.decide()[0]['needed']);self.assertFalse(self.decide()[0]['incomplete'])
    def test_cumulative_useful_information_survives_later_quiet_batch(self):
        self.add()
        self.analyze({'tasks':[],'review_notes':[],'useful_information':[{'text':'明天补课','source_ids':['one'],'quote':'明天补课'}]})
        self.add('later',content='好的收到');self.assertEqual(self.decide(),[])
        self.analyze();self.assertFalse(self.decide()[0]['needed'])
    def test_incomplete_attachment_requires_confirmation_even_if_llm_failed_or_text_useful(self):
        m=self.add(attachments=[{'kind':'document','name':'通知.pdf','stages':{'extracted':'failed'},'error':'文件未下载'}])
        self.assertTrue(self.decide()[0]['incomplete'])
        self.analyze({'tasks':[],'review_notes':[],'useful_information':[{'text':'补课通知','source_ids':['one'],'quote':'明天补课'}]})
        d=self.decide()[0];self.assertTrue(d['needed']);self.assertTrue(d['useful'])
    def test_recovered_attachment_requires_reanalysis_then_removes_or_downgrades(self):
        m=self.add(attachments=[{'kind':'document','stages':{'extracted':'failed'}}]);self.analyze()
        m['attachments']=[{'kind':'document','stages':{'extracted':'ok'},'extracted_text':'报告在周五提交','truncated':False}]
        self.s.save_messages('s','chat',[m],STAMP);self.assertEqual(self.decide(),[])
        self.analyze();d=self.decide()[0];self.assertTrue(d['needed']);self.assertFalse(d['incomplete'])
        self.add('useful',content='考试安排已经确定')
        self.analyze({'tasks':[],'review_notes':[],'useful_information':[{'text':'考试安排','source_ids':['useful'],'quote':'考试安排已经确定'}]})
        self.assertFalse(self.decide()[0]['needed'])
    def test_collection_failure_cannot_become_ordinary_confirmation(self):
        self.add();self.analyze()
        atomic_json(self.s.root/'state/collection-status.json',{'errors':[{'source':'s','chat':'chat'}]})
        self.assertEqual(self.decide(),[])
    def test_nonselected_private_and_feishu_are_excluded(self):
        self.add();self.analyze();self.pick['selected']=[];self.assertEqual(self.decide(),[])
        self.pick['selected']=[{'source_id':'s','chat_id':'chat'}]
        atomic_json(self.s.root/'config/conversation-directory.json',{'conversations':[{'source_id':'s','chat_id':'chat','kind':'private'}]})
        self.assertEqual(self.decide(),[])
    def test_later_added_wechat_and_qq_group_use_identical_decision_pipeline(self):
        c=self.s.config();c['sources'].append({'id':'q','platform':'qq','account_id':'123','account_name':'QQ','db_dir':'','enabled':True});save(self.s,c)
        d={'conversations':[{'source_id':'s','chat_id':'new@chatroom','name':'新增微信群','kind':'group'}, {'source_id':'q','chat_id':'group:9','name':'新增QQ群','kind':'group'}]}
        atomic_json(self.s.root/'config/conversation-directory.json',d)
        self.pick['selected']=[]
        for sid,chat,platform,account in [('s','new@chatroom','wechat','a'),('q','group:9','qq','123')]:
            m={**message(sid), 'timestamp':STAMP,'platform':platform,'source_id':sid,'account_id':account,'chat_id':chat,'content':'闲聊'}
            self.s.save_messages(sid,chat,[m],STAMP);self.pick['selected'].append({'source_id':sid,'chat_id':chat})
        self.analyze();self.analyze()
        result=decisions(self.s,self.pick,NOW);self.assertEqual(len(result),2);self.assertTrue(all(d['needed'] for d in result));self.assertNotEqual(result[0]['key'],result[1]['key'])
    def test_more_than_one_batch_does_not_prematurely_classify_day(self):
        for i in range(45):self.add(str(i))
        self.analyze();self.assertEqual(self.decide(),[])
        self.analyze();self.assertTrue(self.decide()[0]['needed'])
    def test_midnight_uses_ws_shanghai_natural_day(self):
        self.add(timestamp=int(datetime(2026,10,21,23,59,59,tzinfo=TZ).timestamp()))
        self.analyze();self.assertEqual(self.decide(),[])
        self.add('newday',timestamp=int(datetime(2026,10,22,0,0,0,tzinfo=TZ).timestamp()));self.analyze()
        self.assertEqual(self.decide()[0]['day'],'2026-10-22')
    def test_malformed_useful_result_is_not_acknowledged_as_success(self):
        self.add()
        with patch('analysis.request',return_value={'tasks':[],'review_notes':[],'useful_information':[{'text':'假的','source_ids':['unknown'],'quote':'没有的原文'}]}):
            with self.assertRaises(UserError):prepare(self.s,{},[],selection=self.pick)
        self.assertEqual(self.decide(),[])
    def test_legacy_task_only_output_is_not_a_no_useful_information_judgment(self):
        self.add()
        self.analyze({'tasks':[],'review_notes':[]})
        self.assertEqual(self.decide(),[])
    def test_voice_unsupported_thumbnail_and_truncated_document_are_incomplete(self):
        for a in [{'kind':'audio','stages':{'processed':'unprocessed'}},{'kind':'video','stages':{}},{'kind':'image','stages':{'vision':'ok'},'extracted_text':'x','resolution':'thumbnail'},{'kind':'document','stages':{'extracted':'ok'},'extracted_text':'x','truncated':True}]:
            self.assertTrue(incomplete({'attachments':[a]}))

    def test_advanced_prompt_preserves_filters_and_roundtrips(self):
        from worker import dispatch
        rules=self.s.root/'config/rules/analysis.json';r=json.loads(rules.read_text(encoding='utf8'));r['exclude_senders']=['excluded'];atomic_json(rules,r)
        dispatch(self.s,{'command':'save_analysis_prompt','prompt':'优先总结课程与考试安排。'})
        saved=json.loads(rules.read_text(encoding='utf8'));self.assertEqual(saved['exclude_senders'],['excluded']);self.assertEqual(saved['instructions'],'优先总结课程与考试安排。')
        with self.assertRaises(UserError):dispatch(self.s,{'command':'save_analysis_prompt','prompt':'x'*8001})


if __name__=='__main__':unittest.main()
