import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from state import State,atomic_json,UserError
from source_config import save,validate
from worker import dispatch,collect
from test_integration import message
from analysis import prepare

class Sources(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir=os.environ.get('WS_TEST_TMP'));self.state=State(Path(self.tmp.name)/'private')
        self.config=self.state.config()
        self.config['sources']=[{'id':'one','platform':'wechat','account_id':'first','db_dir':'','account_name':'测试账号','enabled':True}]
        self.config=save(self.state,self.config)
    def tearDown(self):self.tmp.cleanup()
    def test_account_change_new_namespace_no_inherited_remote_or_groups(self):
        self.config['sources'][0]['account_id']='second';new=save(self.state,self.config)['sources'][0]
        self.assertNotEqual(new['id'],'one');self.assertNotIn('groups',new);self.assertNotIn('remote',new)
    def test_removed_namespace_cannot_be_reused_for_another_account(self):
        save(self.state,{**self.config,'sources':[]})
        self.config['sources'][0]['account_id']='second';self.assertNotEqual(save(self.state,self.config)['sources'][0]['id'],'one')
    def test_disable_remove_and_credentials_failure_preserve_tasks_and_history(self):
        task=self.state.root/'tasks/tasks.json';atomic_json(task,{'version':1,'tasks':[{'title':'manual fixture','completed':True}]});before=task.read_bytes()
        m=message();m.update(source_id='one',chat_id='test@chatroom');self.state.save_messages('one','test@chatroom',[m],1)
        self.config['sources'][0]['enabled']=False;save(self.state,self.config)
        with patch('analysis.request',side_effect=AssertionError('must not upload')):self.assertFalse(prepare(self.state,{},[],selection={'version':1,'selected':[],'since':0,'until':10})['tasks'])
        self.assertFalse(dispatch(self.state,{'command':'test_source','source_id':'one'})['ok'])
        dispatch(self.state,{'command':'clear_credentials','source_id':'one'})
        save(self.state,{**self.config,'sources':[]})
        self.assertEqual(task.read_bytes(),before);self.assertEqual(len(self.state.messages('one')),1)
    def test_v1_upgrade_and_invalid_future_or_cross_account_scope(self):
        c=self.state.config();c['version']=2;c['asr_enabled']=True;c['remote_asr']=False;c['remote_scope']={}
        c['sources'][0]['remote']={'chats':[]};c['sources'][0]['groups']=['old']
        new=validate(c);self.assertEqual(new['version'],3);self.assertNotIn('remote_scope',new);self.assertNotIn('remote',new['sources'][0])
        c['version']=99
        with self.assertRaises(UserError):validate(c)
    def test_history_delete_preserves_tasks_and_import_journal(self):
        m=message();m.update(source_id='one',chat_id='test@chatroom');self.state.save_messages('one','test@chatroom',[m],1)
        f=self.state.root/'state/task-import-journal.json';atomic_json(f,{'fixture':'done'})
        dispatch(self.state,{'command':'delete_history','source_id':'one'})
        self.assertEqual(self.state.messages('one'),[]);self.assertEqual(json.loads(f.read_text()),{'fixture':'done'})
    def test_qq_unconfigured_shell_reports_setup_required(self):
        c=self.state.config();c['sources'][0].update(platform='qq');c=save(self.state,c)
        r=dispatch(self.state,{'command':'test_source','source_id':c['sources'][0]['id']})
        self.assertFalse(r['ok']);self.assertIn('准备 QQ 环境',r['reason']);self.assertIn('qq_retry',r['needs'])
    def test_same_wechat_account_directory_suffix_change_keeps_namespace_and_old_task_identity(self):
        c=self.state.config();c['sources'][0]['account_id']='wxid_fixture_1234';c=save(self.state,c)
        prior=c['sources'][0]['id'];c['sources'][0]['account_id']='wxid_fixture_abcd';c=save(self.state,c)
        self.assertEqual(c['sources'][0]['id'],prior);self.assertEqual(c['sources'][0]['account_id'],'wxid_fixture_1234')
    def test_readding_same_retired_account_reuses_stable_namespace(self):
        save(self.state,{**self.config,'sources':[]})
        self.config['sources'][0]['id']='new-id'
        self.assertEqual(save(self.state,self.config)['sources'][0]['id'],'one')
    def test_invalid_machine_bound_credential_reports_reconnect_and_preserves_tasks(self):
        import base64
        c=self.state.config();directory=self.state.root/'temp/first/db_storage';directory.mkdir(parents=True)
        c['sources'][0]['db_dir']=str(directory);save(self.state,c)
        task=self.state.root/'tasks/tasks.json';atomic_json(task,{'fixture':'completed user edit'});before=task.read_bytes()
        atomic_json(self.state.root/'secrets/wechat-one.dpapi',{'version':1,'ciphertext':base64.b64encode(b'not-a-valid-Windows-DPAPI-blob').decode()})
        result=dispatch(self.state,{'command':'test_source','source_id':'one'})
        self.assertFalse(result['ok']);self.assertIn('Windows',result['reason']);self.assertEqual(task.read_bytes(),before)
    def test_relocated_pending_analysis_ack_uses_rebased_message_revision(self):
        import shutil
        from state import digest
        from analysis import acknowledge
        m=message();m.update(source_id='one',chat_id='test@chatroom')
        m['attachments']=[{'kind':'document','stages':{'extracted':'ok'},'local_file':str(self.state.root/'cache/attachments/file.txt')}]
        self.state.save_messages('one','test@chatroom',[m],1)
        body={'tasks':[],'revisions':{'one':digest(m)}}
        with self.state.db() as con:con.execute('INSERT INTO analyses VALUES(?,?,?,?)',('pending','ready',json.dumps(body),1))
        target=Path(self.tmp.name)/'relocated';shutil.copytree(self.state.root,target)
        atomic_json(target/'state/import-origin.json',{'version':1,'origin':str(self.state.root)})
        relocated=State(target)
        acknowledge(relocated,'pending',[])
        self.assertFalse(relocated.messages(pending=True))

    def test_import_connection_uses_authenticated_pages_after_path_move(self):
        from fixtures import encrypted_db
        from wechat import import_keys
        client=Path(self.tmp.name)/'first/db_storage/contact';client.mkdir(parents=True)
        key=b'K'*32;encrypted_db(client/'contact.db',"CREATE TABLE contact(username TEXT,nick_name TEXT,remark TEXT);INSERT INTO contact VALUES('one','昵称','备注');",key,b'S'*16)
        c=self.state.config();c['sources'][0]['db_dir']=str(client.parent);c=save(self.state,c);source=c['sources'][0]
        file=self.state.root/'temp/import.json';atomic_json(file,{'db_dir':'C:/old-computer/account/db_storage','keys':{'contact/contact.db':key.hex()}})
        result=import_keys(self.state,source,file);self.assertEqual(result['validated_keys'],1);self.assertEqual(self.state.secret('wechat-'+source['id'])['db_dir'],str(client.parent))
    def test_invalid_machine_credential_repair_backs_up_then_reuses_client_flow(self):
        import base64
        from fixtures import encrypted_db
        from connections import connect
        client=Path(self.tmp.name)/'first/db_storage/contact';client.mkdir(parents=True)
        key=b'K'*32;encrypted_db(client/'contact.db',"CREATE TABLE contact(username TEXT,nick_name TEXT,remark TEXT);INSERT INTO contact VALUES('one','昵称','备注');",key,b'S'*16)
        c=self.state.config();c['sources'][0]['db_dir']=str(client.parent);source=save(self.state,c)['sources'][0]
        atomic_json(self.state.root/'secrets'/('wechat-'+source['id']+'.dpapi'),{'version':1,'ciphertext':base64.b64encode(b'invalid-machine-data').decode()})
        (client.parent/'message').mkdir();encrypted_db(client.parent/'message/message_0.db',"CREATE TABLE t(value TEXT);INSERT INTO t VALUES('fixture');",key,b'S'*16)
        def client_scan(state,src):state.secret('wechat-'+src['id'],{'db_dir':str(client.parent),'keys':{'contact/contact.db':key.hex(),'message/message_0.db':key.hex()}},write=True)
        with patch('wechat.scan',side_effect=client_scan):result=connect(self.state,source,repair=True)
        self.assertTrue(result['ok']);self.assertTrue(list((self.state.root/'backups').glob('connection-before-repair-*.dpapi')))

    def test_metadata_only_credentials_are_not_reported_as_full_connection(self):
        from fixtures import encrypted_db
        from connections import connect
        client=Path(self.tmp.name)/'first/db_storage/contact';client.mkdir(parents=True)
        key=b'K'*32;encrypted_db(client/'contact.db',"CREATE TABLE contact(username TEXT,nick_name TEXT,remark TEXT);INSERT INTO contact VALUES('one','昵称','备注');",key,b'S'*16)
        (client.parent/'message').mkdir();encrypted_db(client.parent/'message/message_0.db',"CREATE TABLE t(value TEXT);INSERT INTO t VALUES('fixture');",key,b'S'*16)
        c=self.state.config();c['sources'][0]['db_dir']=str(client.parent);source=save(self.state,c)['sources'][0]
        self.state.secret('wechat-'+source['id'],{'db_dir':str(client.parent),'keys':{'contact/contact.db':key.hex()}},write=True)
        result=connect(self.state,source);self.assertFalse(result['ok']);self.assertIn('消息文件',result['reason'])

if __name__=='__main__':unittest.main()

