import json,os,tempfile,unittest,hashlib
from datetime import datetime,timezone,timedelta
from pathlib import Path
from unittest.mock import patch
import httpx
from state import State,atomic_json,digest,UserError
from source_config import save
from analysis import prepare,acknowledge,request,checked_batch
from summaries import generate
from ws_workflow import default_window,saved_selection,save_selection,collect_selected
from test_integration import message

class Optimizations052(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(dir=os.environ['WS_TEST_TMP']);self.s=State(Path(self.temp.name)/'private')
  c=self.s.config();c['sources']=[{'id':'s','platform':'wechat','account_id':'a','account_name':'测试账号','db_dir':'','enabled':True}];save(self.s,c)
  self.pick={'version':1,'selected':[{'source_id':'s','chat_id':'chat'}],'since':0,'until':100}
  self.s.save_messages('s','chat',[message('first','请提交实验报告'),message('second','今晚讨论作业')],10)
 def tearDown(self):self.temp.cleanup()
 def task(self,**changes):
  return {'title':'提交实验报告','description':'按照要求提交','plan_date':'2026-10-23','due_date':None,'priority':'normal','source_ids':['first'],'evidence':[{'message_id':'first','quote':'请提交实验报告'}],'applies_to_me':True,'uncertainty':'','confidence':.9,'existing_task_id':None,**changes}
 def answer(self,**changes):return {'tasks':[self.task()],'review_notes':[],'useful_information':[],**changes}
 def test_repair_missing_evidence_with_same_scope_then_ack_skips_old_messages(self):
  wrong=self.answer(tasks=[self.task(source_ids=['first','second'])])
  with patch('analysis.request',side_effect=[wrong,self.answer()]) as model:
   result=prepare(self.s,{},[],selection=self.pick)
  self.assertEqual(model.call_count,2);self.assertEqual(model.call_args_list[0].args[1],model.call_args_list[1].args[1]);self.assertEqual(len(result['tasks']),1)
  acknowledge(self.s,result['analysis_id'],[{'key':result['tasks'][0]['key'],'status':'imported'}])
  with patch('analysis.request',side_effect=AssertionError('completed messages must not upload again')):
   self.assertEqual(prepare(self.s,{},[],selection=self.pick)['status'],'up_to_date')
 def test_bad_item_does_not_discard_other_valid_tasks_or_classify_unknown_as_useless(self):
  wrong=self.task(title='无法核对的候选',source_ids=['first','second'])
  with patch('analysis.request',return_value=self.answer(tasks=[self.task(),wrong])) as model:result=prepare(self.s,{},[],selection=self.pick)
  self.assertEqual(model.call_count,2);self.assertEqual(len(result['tasks']),1);self.assertTrue(result['needs_review']);self.assertFalse(result['usefulness_classified'])
  self.assertTrue(any('无法核对的候选' in note for note in result['notes']))
  acknowledge(self.s,result['analysis_id'],[{'key':result['tasks'][0]['key'],'status':'imported'}])
  with self.s.db() as con:self.assertIsNone(con.execute("SELECT 1 FROM message_receipts WHERE message='second'").fetchone())
 def test_wire_short_references_roundtrip_to_canonical_ids(self):
  canonical='a'*64;seen=[];Client=httpx.Client
  def handler(req):
   payload=json.loads(req.content);body=json.loads(payload['messages'][1]['content']);seen.append(body)
   self.assertEqual(body['messages'][0]['id'],'m1');self.assertEqual(body['existing_tasks'][0]['id'],'t1');self.assertNotIn(canonical,req.content.decode())
   answer=self.answer(tasks=[self.task(source_ids=['m1'],evidence=[{'message_id':'m1','quote':'请提交实验报告'}],existing_task_id='t1')])
   return httpx.Response(200,json={'choices':[{'finish_reason':'stop','message':{'content':json.dumps(answer)}}]})
  with patch('analysis.httpx.Client',side_effect=lambda **kwargs:Client(transport=httpx.MockTransport(handler),**kwargs)):
   result=request({'baseUrl':'http://127.0.0.1','model':'fixture','key':'fixture'},[{'id':canonical,'text':'请提交实验报告'}],'',[{'id':'existing-canonical'}])
  self.assertEqual(result['tasks'][0]['source_ids'],[canonical]);self.assertEqual(result['tasks'][0]['evidence'][0]['message_id'],canonical);self.assertEqual(result['tasks'][0]['existing_task_id'],'existing-canonical')
 def test_recollection_and_same_attachment_enrichment_do_not_reset_analysis_receipt(self):
  original=message('media','课程安排');original['attachments']=[{'kind':'image','stages':{'vision':'ok'},'source_fingerprint':'stable','extracted_text':'已识别正文'}]
  self.s.save_messages('s','chat',[original],10)
  with self.s.db() as con:con.execute("UPDATE messages SET analyzed=revision WHERE id='media'")
  raw={**original,'attachments':[{'kind':'image','stages':{'vision':'pending'},'source_fingerprint':'stable'}]}
  self.s.save_messages('s','chat',[raw],10);self.assertTrue(any(m['id']=='media' for m in self.s.messages(pending=True)))
  self.s.save_messages('s','chat',[original],10);self.assertFalse(any(m['id']=='media' for m in self.s.messages(pending=True)))
 def test_summary_new_chat_reuses_unchanged_chat_then_new_message_updates_only_changed_chat(self):
  other={**message('other','课程通知二'),'chat_id':'other'};self.s.save_messages('s','other',[other],10)
  def reply(llm,rows,*a,**k):return {'topics':[{'text':rows[-1]['text'],'quote':rows[-1]['text'],'source_ids':[rows[-1]['id']]}],'notices':[],'conclusions':[],'uncertainties':[]}
  with patch('analysis.request',side_effect=reply):generate(self.s,self.pick,{})
  self.pick['selected'].append({'source_id':'s','chat_id':'other'})
  with patch('analysis.request',side_effect=reply) as model:r=generate(self.s,self.pick,{})
  self.assertEqual(model.call_count,1);self.assertEqual([c['status'] for c in r['conversations']],['cached','generated'])
  new={**message('new','新增考试通知'),'timestamp':2};self.s.save_messages('s','chat',[new],10)
  with patch('analysis.request',side_effect=reply) as model:r=generate(self.s,self.pick,{})
  self.assertEqual(model.call_count,1);self.assertEqual([c['status'] for c in r['conversations']],['generated','cached'])
 def test_future_end_is_not_written_as_collection_cursor_and_later_messages_can_be_read(self):
  observed=[]
  class Reader:
   root=self.s.root/'client';source={'id':'s'}
   def conversations(self):return [{'id':'chat'}]
   def iter_messages(self,chat,since,until):observed.append(until);yield {**message('fresh','新增消息'),'timestamp':min(until,105)}
  pick={**self.pick,'until':200}
  with patch('ws_workflow.time.time',return_value=100):collect_selected(self.s,pick,lambda *_:Reader())
  with self.s.db() as con:self.assertEqual(con.execute("SELECT until FROM cursors WHERE source='s' AND chat='chat'").fetchone()[0],100)
  with patch('ws_workflow.time.time',return_value=110):collect_selected(self.s,pick,lambda *_:Reader())
  self.assertEqual(observed,[100,110]);self.assertEqual(next(m for m in self.s.messages() if m['id']=='fresh')['timestamp'],105)
 def test_system_default_window_and_rolling_day_change_preserve_selection(self):
  tz=timezone(timedelta(hours=8));now=datetime(2026,10,23,12,tzinfo=tz);bounds=default_window(now)
  self.assertEqual(datetime.fromtimestamp(bounds['since'],tz),datetime(2026,10,22,tzinfo=tz));self.assertEqual(datetime.fromtimestamp(bounds['until'],tz),datetime(2026,10,23,23,59,59,tzinfo=tz))
  atomic_json(self.s.root/'config/summary.json',self.pick);atomic_json(self.s.root/'state/summary-window.json',{'mode':'rolling'})
  with patch('ws_workflow.default_window',return_value=bounds):r=saved_selection(self.s)
  self.assertEqual(r['selected'],self.pick['selected']);self.assertEqual(r['since'],bounds['since'])
  save_selection(self.s,self.pick)
  with patch('ws_workflow.default_window',return_value=bounds):self.assertEqual(saved_selection(self.s),self.pick)
 def test_overflow_information_does_not_classify_unchecked_messages_as_useless(self):
  rows=[{'id':'first','group_id':'chat','group_name':'课程群','timestamp':1,'sender':'老师','text':'请提交实验报告'}]
  raw={'tasks':[],'review_notes':[],'useful_information':[{'text':'提交报告','source_ids':['first'],'quote':'请提交实验报告'}]*101}
  result=checked_batch(raw,rows,[],partial=True)
  self.assertFalse(result[-2]);self.assertTrue(result[-1]);self.assertEqual(len(result[4]),100)
 def test_summary_limit_includes_latest_messages_instead_of_staying_on_oldest_page(self):
  self.s.save_messages('s','chat',[{**message('later-'+str(i),'新消息 '+str(i)),'timestamp':i+2} for i in range(201)],300)
  def reply(llm,rows,*a,**k):
   self.assertEqual(rows[-1]['id'],'later-200');self.assertNotIn('first',[m['id'] for m in rows]);return {'topics':[],'notices':[],'conclusions':[],'uncertainties':[]}
  with patch('analysis.request',side_effect=reply):result=generate(self.s,{**self.pick,'until':300},{})
  self.assertEqual(result['conversations'][0]['coverage']['sent'],200);self.assertTrue(result['conversations'][0]['coverage']['limited'])

if __name__=='__main__':unittest.main()
