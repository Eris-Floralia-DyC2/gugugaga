import os,tempfile,unittest
from pathlib import Path
from state import State,atomic_json,read_json
from source_config import save
from qq_accounts import begin_switch,bind
from qq import QQ

class QQAccounts(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir=os.environ['WS_TEST_TMP']);self.s=State(Path(self.tmp.name)/'private')
        self.a={'id':'qq-a','platform':'qq','account_id':'A','account_name':'账号 A','enabled':True,'db_dir':''}
        c=self.s.config();c['sources']=[self.a];save(self.s,c)
        self.pick={'version':1,'selected':[{'source_id':'wechat','chat_id':'keep@chatroom'},{'source_id':'qq-a','chat_id':'group:old'}],'since':0,'until':10}
        atomic_json(self.s.root/'config/summary.json',self.pick)
        atomic_json(self.s.root/'tasks/tasks.json',{'fixture':'completed and edited tasks'});self.before=(self.s.root/'tasks/tasks.json').read_bytes()
    def tearDown(self):self.tmp.cleanup()
    def test_switch_new_account_isolates_selection_and_return_restores_old_namespace(self):
        begin_switch(self.s,'qq-a');self.assertEqual(len(read_json(self.s.root/'config/summary.json')['selected']),1)
        b=bind(self.s,self.a,{'account_id':'B','account_name':'账号 B'});self.assertNotEqual(b['id'],self.a['id'])
        self.assertEqual(read_json(self.s.root/'config/summary.json')['selected'],[self.pick['selected'][0]])
        pick=read_json(self.s.root/'config/summary.json');pick['selected'].append({'source_id':b['id'],'chat_id':'group:new'});atomic_json(self.s.root/'config/summary.json',pick)
        begin_switch(self.s,b['id']);a=bind(self.s,b,{'account_id':'A','account_name':'账号 A'})
        self.assertEqual(a['id'],'qq-a');self.assertEqual(read_json(self.s.root/'config/summary.json'),self.pick)
        self.assertEqual((self.s.root/'tasks/tasks.json').read_bytes(),self.before)
        begin_switch(self.s,a['id']);again=bind(self.s,a,{'account_id':'B','account_name':'账号 B'});self.assertEqual(again['id'],b['id'])
        self.assertEqual(read_json(self.s.root/'config/summary.json')['selected'][-1]['chat_id'],'group:new')
    def test_cancel_switch_by_logging_same_account_restores_current_selection(self):
        begin_switch(self.s,'qq-a');a=bind(self.s,self.a,{'account_id':'A','account_name':'账号 A'})
        self.assertEqual(a['id'],'qq-a');self.assertEqual(read_json(self.s.root/'config/summary.json'),self.pick)
    def test_paused_session_cannot_read_qq_but_keeps_existing_state(self):
        from state import UserError
        atomic_json(self.s.root/'state/qq-session.json',{'version':1,'paused':True})
        with self.assertRaisesRegex(UserError,'后台已暂停'):QQ(self.s,self.a)
        self.assertEqual((self.s.root/'tasks/tasks.json').read_bytes(),self.before)

if __name__=='__main__':unittest.main()
