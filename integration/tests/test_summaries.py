import json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from state import State,atomic_json
from source_config import save
from test_integration import message
from summaries import generate,options,validate_selection

class Summaries(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir=os.environ.get('WS_TEST_TMP'));self.s=State(Path(self.tmp.name)/'private')
        c=self.s.config();c['sources']=[{'id':'s','platform':'wechat','account_id':'a','account_name':'测试账号','db_dir':'','enabled':True}];save(self.s,c)
        m=message(content='周五交实验报告');self.s.save_messages('s','chat',[m],10)
        other=message('foreign',content='unselected private fixture');other['chat_id']='other';self.s.save_messages('s','other',[other],10)
        self.selection={'version':1,'selected':[{'source_id':'s','chat_id':'chat'}],'since':0,'until':10}
        atomic_json(self.s.root/'config/summary.json',self.selection)
    def tearDown(self):self.tmp.cleanup()
    def result(self,ids=['one']):
        return {'topics':[{'text':'实验报告提交通知','source_ids':ids,'quote':'周五交实验报告'}],'notices':[],'conclusions':[],'uncertainties':[]}
    def test_only_selected_body_reaches_request_no_tasks_and_selection_survives_restart(self):
        before=(self.s.root/'databases/messages.sqlite3').read_bytes()
        with patch('analysis.request',return_value=self.result()) as mock:
            result=generate(self.s,self.selection,{})
            payload=mock.call_args.args[1];self.assertEqual([m['id'] for m in payload],['one'])
            self.assertNotIn('unselected private fixture',json.dumps(payload))
        self.assertEqual(result['tasks_created'],0);self.assertEqual(result['conversations'][0]['status'],'generated')
        fresh=State(self.s.root);saved=json.loads((fresh.root/'config/summary.json').read_text());self.assertEqual(saved,self.selection)
        audit=json.loads(next((self.s.root/'summaries').glob('*-audit.json')).read_text());self.assertEqual(audit['queried'],self.selection['selected'])
        self.assertFalse((self.s.root/'tasks/tasks.json').exists())
    def test_disabled_source_does_not_read_or_upload(self):
        c=self.s.config();c['sources'][0]['enabled']=False;save(self.s,c)
        with patch.object(self.s,'messages',side_effect=AssertionError('must not read')),patch('analysis.request',side_effect=AssertionError('must not upload')):
            result=generate(self.s,self.selection,{})
        self.assertEqual(result['conversations'][0]['status'],'blocked')
    def test_foreign_citation_and_invented_quote_rejected(self):
        with patch('analysis.request',return_value=self.result(['foreign'])):
            result=generate(self.s,self.selection,{})
        self.assertEqual(result['conversations'][0]['status'],'failed');self.assertEqual(result['conversations'][0]['topics'],[])
    def test_invalid_citation_gets_one_bounded_repair_with_same_selected_messages(self):
        with patch('analysis.request',side_effect=[self.result(['foreign']),self.result()]) as mock:
            result=generate(self.s,self.selection,{})
        self.assertEqual(mock.call_count,2)
        self.assertEqual(mock.call_args_list[0].args[1],mock.call_args_list[1].args[1])
        self.assertIn('上次输出未通过来源校验',mock.call_args_list[1].args[4])
        self.assertEqual(result['conversations'][0]['status'],'generated')
    def test_multi_select_separates_each_conversation_and_counts_empty_range(self):
        self.selection['selected'].append({'source_id':'s','chat_id':'other'})
        def answer(llm,payload,*args,**kwargs):
            text=payload[0]['text'];return {'topics':[{'text':text,'source_ids':[payload[0]['id']],'quote':text}],'notices':[],'conclusions':[],'uncertainties':[]}
        with patch('analysis.request',side_effect=answer) as mock:result=generate(self.s,self.selection,{})
        self.assertEqual(mock.call_count,2);self.assertTrue(all(len(c['sources'])==1 for c in result['conversations']))
        self.selection.update(since=8,until=9)
        with patch('analysis.request',side_effect=AssertionError('empty range cannot upload')):r=generate(self.s,self.selection,{})
        self.assertTrue(all(c['status']=='insufficient' for c in r['conversations']))
    def test_name_change_keeps_stable_selection_and_duplicate_names_distinct(self):
        class Reader:
            def conversations(self):return [{'id':'chat','name':'renamed conversation','kind':'private'},{'id':'other','name':'renamed conversation','kind':'group'}]
        atomic_json(self.s.root/'config/summary.json',self.selection)
        data=options(self.s,lambda *_:Reader())
        self.assertEqual(data['selection'],self.selection);self.assertEqual(len(data['conversations']),2)
        self.assertEqual(len({o['chat_id'] for o in data['conversations']}),2)
    def test_missing_voice_and_attachment_visible_not_guessed(self):
        m=message(content='周五交实验报告');m['attachments']=[{'kind':'audio','stages':{'transcribed':'failed'}},{'kind':'document','stages':{'extracted':'failed'}}];self.s.save_messages('s','chat',[m],10)
        with patch('analysis.request',return_value=self.result()):r=generate(self.s,self.selection,{})
        text=' '.join(r['conversations'][0]['missing']);self.assertIn('语音未处理',text);self.assertIn('附件',text)

    def test_old_execution_snapshot_does_not_overwrite_a_new_deselection(self):
        latest={**self.selection,'selected':[]};atomic_json(self.s.root/'config/summary.json',latest)
        with patch('analysis.request',return_value=self.result()):generate(self.s,self.selection,{})
        self.assertEqual(json.loads((self.s.root/'config/summary.json').read_text()),latest)

if __name__=='__main__':unittest.main()
