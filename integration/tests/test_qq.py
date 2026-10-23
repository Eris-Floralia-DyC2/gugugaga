"""Deterministic HTTP protocol fixtures; these do not count as live QQ acceptance."""
import json, os, tempfile, threading, unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from state import State, atomic_json, UserError
from source_config import save
from qq import QQ, AuthRequired
from ws_workflow import collect_selected


class QQProtocol(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=os.environ['WS_TEST_TMP']);self.s=State(Path(self.temp.name)/'private')
        self.source={'id':'q','platform':'qq','account_id':'123','account_name':'fixture','db_dir':'','enabled':True}
        c=self.s.config();c['sources']=[self.source];save(self.s,c)
        atomic_json(self.s.root/'qq/profile/.qq-chat-exporter/security.json',{'accessToken':'fixture-secret','allowedIPs':['127.0.0.1','::1'],'disableIpWhitelist':False})
        self.posts=[];self.paths=[];self.mode='plugin';self.online=True;self.account='123';self.http_status=200;self.task_status='completed';self.namespaced=False
        self.export=self.s.root/'qq/exports/fixture.json';self.export.parent.mkdir(exist_ok=True)
        self.native='9007199254740993123456789'
        self.body={'chatInfo':{'type':'group','selfUin':'123','peerUid':'9'},'messages':[{'id':self.native,'timestamp':1000000,
            'sender':{'uid':'u_sender','name':'发送人'},'content':{'text':'课程通知','elements':[],'resources':[]},'type':'type_1'}]}
        self.write_export()
        outer=self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*_):pass
            def do_GET(self):self.handle_request()
            def do_POST(self):self.handle_request()
            def handle_request(self):
                outer.paths.append(self.path)
                if self.command=='POST':outer.posts.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                if self.path=='/api/system/info':data={'version':'6.3.2','mode':outer.mode,'napcat':{'online':outer.online,'workingEnv':'shell','selfInfo':{'uin':outer.account,'nick':'fixture'}}}
                elif self.path.startswith('/api/groups?'):data={'groups':[{'groupCode':'9','groupName':'fixture group'}],'hasNext':False}
                elif self.path.startswith('/api/friends?'):data={'friends':[{'uid':'u_friend','remark':'fixture friend','nick':'nick'}],'hasNext':False}
                elif self.path.startswith('/api/messages/export'):data={'taskId':'fixture-task'}
                elif self.path.startswith('/api/tasks/'):data={'taskId':'fixture-task','status':outer.task_status,'filePath':('\\\\?\\' if outer.namespaced else '')+str(outer.export),'messageCount':len(outer.body['messages'])}
                else:data={}
                raw=json.dumps({'success':True,'data':data}).encode();self.send_response(outer.http_status);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(raw)
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.port=patch('qq.PORT',self.server.server_port);self.port.start()
    def tearDown(self):self.port.stop();self.server.shutdown();self.server.server_close();self.thread.join();self.temp.cleanup()
    def write_export(self):atomic_json(self.export,self.body)
    def read(self,chat='group:9'):return list(QQ(self.s,self.source).iter_messages(chat,0,2000))
    def test_group_and_private_use_same_export_pipeline_and_string_ids(self):
        group=self.read()[0];self.assertEqual(group['message_id'],self.native);self.assertEqual(group['timestamp'],1000);self.assertEqual(group['sender_name'],'发送人')
        self.body['chatInfo'].update(type='private',peerUid='u_friend');self.write_export();private=self.read('private:u_friend')[0]
        self.assertEqual(private['message_id'],self.native);self.assertNotEqual(group['id'],private['id'])
        self.assertEqual([p['peer']['chatType'] for p in self.posts],[2,1]);self.assertTrue(all(p['format']=='JSON' for p in self.posts))
    def test_repeat_import_dedupes_and_uses_cursor_overlap(self):
        pick={'version':1,'selected':[{'source_id':'q','chat_id':'group:9'}],'since':0,'until':2000}
        first=collect_selected(self.s,pick,QQ);self.assertFalse(first['errors']);self.assertEqual(len(self.s.messages('q')),1)
        # A message in the overlap window is repeated, preserving its original string identity.
        self.body['messages'][0]['timestamp']=1900000;self.write_export()
        second=collect_selected(self.s,pick,QQ);self.assertFalse(second['errors']);self.assertEqual(len(self.s.messages('q')),1)
        self.assertEqual(self.posts[-1]['filter']['startTime'],1700)
    def test_document_uses_shared_parser_and_unavailable_resource_is_marked(self):
        path=self.export.parent/'course.txt';path.write_text('下周提交课程报告',encoding='utf8')
        self.body['messages'][0]['content']['resources']=[{'type':'file','filename':'course.txt','localPath':str(path)}, {'type':'image','filename':'missing.png','url':'https://example.invalid/private-token'}]
        self.write_export();m=self.read()[0]
        self.assertIn('下周提交',m['attachments'][0]['extracted_text']);self.assertEqual(m['attachments'][0]['stages']['extracted'],'ok')
        self.assertIn('error',m['attachments'][1]);self.assertNotIn('private-token',json.dumps(m));self.assertFalse(any('example.invalid' in p for p in self.paths))
    @unittest.skipUnless(os.name=='nt','Windows namespaced paths')
    def test_real_qce_long_path_prefix_keeps_containment_check(self):
        self.namespaced=True
        self.assertEqual(self.read()[0]['message_id'],self.native)
        outside=self.s.root/'outside.json';self.export=outside;self.write_export()
        with self.assertRaisesRegex(UserError,'专用导出目录'):self.read()
    def test_source_path_escape_never_reads_arbitrary_file(self):
        secret=self.s.root/'do-not-read.txt';secret.write_text('private outside exports',encoding='utf8')
        self.body['messages'][0]['content']['resources']=[{'type':'file','localPath':str(secret)}];self.write_export()
        a=self.read()[0]['attachments'][0];self.assertIn('error',a);self.assertNotIn('extracted_text',a)
    def test_standalone_offline_and_wrong_account_are_not_empty_success(self):
        self.mode='standalone'
        with self.assertRaisesRegex(UserError,'完整模式'):self.read()
        self.mode='plugin';self.online=False
        with self.assertRaises(AuthRequired):self.read()
        self.online=True;self.account='999'
        with self.assertRaises(AuthRequired):self.read()
        self.assertEqual(self.posts,[])
    def test_auth_failure_has_no_blind_retry(self):
        self.http_status=403
        with self.assertRaises(AuthRequired):self.read()
        self.assertEqual(len(self.paths),1)
    def test_numeric_id_and_wrong_export_identity_are_rejected_before_save(self):
        self.body['messages'][0]['id']=9007199254740993;self.write_export()
        with self.assertRaisesRegex(UserError,'原始字符串'):self.read()
        self.body['messages'][0]['id']=self.native;self.body['chatInfo']['selfUin']='other';self.write_export()
        with self.assertRaisesRegex(UserError,'身份不匹配'):self.read()
        self.assertEqual(self.s.messages(),[])
    def test_failed_export_does_not_commit_cursor_or_delete_tasks(self):
        self.task_status='failed';pick={'version':1,'selected':[{'source_id':'q','chat_id':'group:9'}],'since':0,'until':2000}
        r=collect_selected(self.s,pick,QQ);self.assertTrue(r['errors'])
        with self.s.db() as con:self.assertIsNone(con.execute('SELECT * FROM cursors').fetchone())
    def test_known_unsupported_elements_are_visible_as_incomplete(self):
        self.body['messages'][0]['content']['elements']=[{'type':'audio','data':{'url':'secret'}}];self.write_export()
        m=self.read()[0];self.assertEqual(m['attachments'][0]['kind'],'audio');self.assertIn('error',m['attachments'][0])


if __name__=='__main__':unittest.main()
