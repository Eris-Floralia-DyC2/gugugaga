import json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import httpx
from state import State,atomic_json,UserError
from feature_rules import settings,save,validate
from source_config import save as save_source
from analysis import request,prepare
from summaries import generate
from test_integration import message

class Features053(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(dir=os.environ['WS_TEST_TMP']);self.s=State(Path(self.tmp.name)/'private')
  c=self.s.config();c['sources']=[{'id':'s','platform':'wechat','account_id':'a','account_name':'验收账号','db_dir':'','enabled':True}];save_source(self.s,c)
  self.s.save_messages('s','chat',[message(content='周五交报告')],10)
  self.pick={'version':1,'selected':[{'source_id':'s','chat_id':'chat'}],'since':0,'until':10}
  self.features={'version':1,'summary':{'instructions':'只概括课程讨论','max_tokens':8192},'tasks':{'instructions':'只提取明确作业','max_tokens':2048}}
 def tearDown(self):self.tmp.cleanup()
 def summary(self):return {'topics':[{'text':'报告安排','source_ids':['one'],'quote':'周五交报告'}],'notices':[],'conclusions':[],'uncertainties':[]}
 def test_existing_prompt_is_fallback_without_mutation(self):
  rules=self.s.root/'config/rules/analysis.json';old=rules.read_bytes();value=settings(self.s)
  self.assertEqual(value['summary']['instructions'],value['tasks']['instructions']);self.assertEqual(value['tasks']['max_tokens'],4096)
  self.assertEqual(old,rules.read_bytes());self.assertFalse((self.s.root/'config/rules/ai-features.json').exists())
 def test_independent_settings_persist_and_invalid_limits_do_not_overwrite(self):
  save(self.s,self.features);self.assertEqual(settings(self.s),self.features);file=self.s.root/'config/rules/ai-features.json';before=file.read_bytes()
  for invalid in (True,255,32769,4096.5,'8192'):
   value=json.loads(json.dumps(self.features));value['summary']['max_tokens']=invalid
   with self.assertRaises(UserError):save(self.s,value)
   self.assertEqual(before,file.read_bytes())
 def test_task_analysis_uses_only_task_overrides(self):
  save(self.s,self.features)
  with patch('analysis.request',return_value={'tasks':[],'review_notes':[],'useful_information':[]}) as model:prepare(self.s,{},[],selection=self.pick)
  self.assertEqual(model.call_args.args[0]['feature_max_tokens'],2048);self.assertEqual(model.call_args.args[4],'只提取明确作业')
 def test_summary_override_and_cache_follow_only_summary_changes(self):
  save(self.s,self.features)
  with patch('analysis.request',return_value=self.summary()) as model:
   generate(self.s,self.pick,{})
   self.assertEqual(model.call_args.args[0]['feature_max_tokens'],8192);self.assertIn('只概括课程讨论',model.call_args.args[4]);self.assertNotIn('只提取明确作业',model.call_args.args[4])
   self.features['tasks']['instructions']='更改任务规则';save(self.s,self.features)
   self.assertEqual(generate(self.s,self.pick,{})['conversations'][0]['status'],'cached');self.assertEqual(model.call_count,1)
   self.features['summary']['max_tokens']=16384;save(self.s,self.features);generate(self.s,self.pick,{})
   self.assertEqual(model.call_count,2);self.assertEqual(model.call_args.args[0]['feature_max_tokens'],16384)
 def test_configured_limit_reaches_actual_http_payload(self):
  Client=httpx.Client;seen=[]
  def handler(req):
   seen.append(json.loads(req.content));return httpx.Response(200,json={'choices':[{'finish_reason':'stop','message':{'content':'{"tasks":[],"review_notes":[]}'}}]})
  with patch('analysis.httpx.Client',side_effect=lambda **kw:Client(transport=httpx.MockTransport(handler),**kw)):
   request({'baseUrl':'http://127.0.0.1','key':'fixture','model':'fixture','feature_max_tokens':8192},[{'id':'one','text':'周五交报告'}],'',[])
  self.assertEqual(seen[0]['max_tokens'],8192)

if __name__=='__main__':unittest.main()
