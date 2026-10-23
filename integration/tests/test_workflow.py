import json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from state import State,atomic_json
from source_config import save
from ws_workflow import collect_selected,save_selection
from test_integration import message
from analysis import prepare

class Workflow(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(dir=os.environ['WS_TEST_TMP']);self.s=State(Path(self.tmp.name)/'private')
  c=self.s.config();c['sources']=[{'id':'s','platform':'wechat','account_id':'a','account_name':'测试','db_dir':'','enabled':True}];save(self.s,c)
  self.pick={'version':1,'selected':[{'source_id':'s','chat_id':'chat'}],'since':0,'until':10}
 def tearDown(self):self.tmp.cleanup()
 def test_collection_uses_only_selected_chat_range_and_saving_makes_no_ai_request(self):
  seen=[];s=self.s
  class Reader:
   root=s.root/'client/db_storage';source={'id':'s'}
   def conversations(self):return [{'id':'chat','name':'选中'},{'id':'other','name':'未选中'}]
   def iter_messages(self,chat,since,until):seen.append((chat,since,until));yield message()
  with patch('analysis.request',side_effect=AssertionError('selection and collection cannot request AI')):
   save_selection(s,self.pick);r=collect_selected(s,self.pick,lambda *_:Reader())
  self.assertEqual(seen,[('chat',0,10)]);self.assertFalse(r['errors']);self.assertEqual(len(s.messages()),1)
  self.pick['selected']=[];r=collect_selected(s,self.pick,lambda *_:self.fail('deselected cannot read'));self.assertEqual(r['read'],0);self.assertEqual(len(s.messages()),1)
 def test_scope_escape_from_adapter_does_not_save(self):
  s=self.s
  class Reader:
   root=s.root/'client/db_storage';source={'id':'s'}
   def conversations(self):return [{'id':'chat'}]
   def iter_messages(self,*_):m=message();m['chat_id']='other';yield m
  r=collect_selected(s,self.pick,lambda *_:Reader());self.assertTrue(r['errors']);self.assertEqual(s.messages(),[])
 def test_unselected_ready_outbox_never_returns_for_same_account(self):
  self.s.save_messages('s','other',[{**message('foreign'), 'chat_id':'other'}],1)
  with self.s.db() as c:c.execute('INSERT INTO analyses VALUES(?,?,?,?)',('old','ready',json.dumps({'tasks':[],'revisions':{'foreign':'old'}}),1))
  with patch('analysis.request',side_effect=AssertionError('unselected cannot upload')):r=prepare(self.s,{},[],selection=self.pick)
  self.assertNotIn('analysis_id',r)
 def test_legacy_upgrade_keeps_saved_selection_but_erases_old_permission_fields(self):
  c=self.s.config();c['version']=2;c.pop('schedule_action');c['remote_scope']={};c['asr_enabled']=True;c['remote_asr']=False
  c['sources'][0].update(groups=['other'],remote={'chats':[]},range={'since':None,'until':None},schedule={})
  atomic_json(self.s.config_file,c);save_selection(self.s,self.pick);new=self.s.config()
  self.assertEqual(new['version'],3);self.assertNotIn('remote_scope',new);self.assertNotIn('remote',new['sources'][0]);self.assertEqual(json.loads((self.s.root/'config/summary.json').read_text()),self.pick)

 def test_feishu_voice_resource_is_never_downloaded(self):
  from feishu import Feishu
  from types import SimpleNamespace
  from unittest.mock import AsyncMock
  r=Feishu.__new__(Feishu);r.state=self.s;r.source={'id':'s','account_id':'a'}
  r.verify_account=AsyncMock()
  r.client=SimpleNamespace(list_messages=AsyncMock(return_value={'messages':[{'message_id':'v','content':{'file_key':'private-media-credential'},'resources':[{'type':'file','key':'secret'}],'sender':{},'create_time':'1000','parent_id':None,'msg_type':'audio'}],'has_more':False}),download_message_resource=AsyncMock(side_effect=AssertionError('must not download voice')))
  rows=list(r.iter_messages('chat',0,10));self.assertEqual(rows[0]['content'],'[语音未处理]');self.assertEqual(rows[0]['parse_status'],'unprocessed');self.assertFalse(r.client.download_message_resource.called)

 def test_legacy_ready_voice_batch_is_not_imported_or_reanalysed(self):
  from state import digest
  voice=message('legacy-voice',content='旧的语音转写');voice['message_type']=34
  voice['attachments']=[{'kind':'audio','stages':{'transcribed':'ok'},'extracted_text':'旧语音内容'}]
  self.s.save_messages('s','chat',[voice],1)
  body={'tasks':[{'key':'old-voice-placeholder','title':'确认语音'}],'revisions':{'legacy-voice':digest(voice)}}
  with self.s.db() as con:con.execute('INSERT INTO analyses VALUES(?,?,?,?)',('voice-ready','ready',json.dumps(body),1))
  with patch('analysis.request',side_effect=AssertionError('voice cannot generate a new request')):result=prepare(self.s,{},[],selection=self.pick)
  self.assertNotIn('analysis_id',result);self.assertEqual(result['tasks'],[])
  with self.s.db() as con:self.assertEqual(con.execute("SELECT status FROM analyses WHERE id='voice-ready'").fetchone()[0],'ready')
