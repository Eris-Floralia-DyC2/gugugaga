"""Build synthetic encrypted input; never read the user's platform databases."""
import os,sys,time,hashlib
from pathlib import Path
project=Path(__file__).resolve().parents[1];sys.path[:0]=[str(project/'integration'),str(project/'integration/tests'),str(project/'integration/vendor')]
from fixtures import encrypted_db
from state import atomic_json
root=Path(os.environ['WS_TEST_DATA']);root.mkdir(parents=True,exist_ok=False)
account=root.parent/'原始客户端/fixtureaccount/db_storage';(account/'contact').mkdir(parents=True);(account/'message').mkdir()
key=b'K'*32;salt=b'S'*16;now=int(time.time());start=now-3600
chat='fixture@chatroom';other='other@chatroom';table='Msg_'+hashlib.md5(chat.encode()).hexdigest();table2='Msg_'+hashlib.md5(other.encode()).hexdigest()
encrypted_db(account/'contact/contact.db',"CREATE TABLE contact(username TEXT,nick_name TEXT,remark TEXT);INSERT INTO contact VALUES('fixture@chatroom','课程群一','备注验收群'),('other@chatroom','课程群二','第二验收群');",key,salt)
sql=f"CREATE TABLE {table}(local_id INTEGER,local_type INTEGER,create_time INTEGER,message_content TEXT);INSERT INTO {table} VALUES(1,1,{start+10},'请在周五提交验收报告。'),(2,1,{start+20},'今晚可以讨论实验安排。');CREATE TABLE {table2}(local_id INTEGER,local_type INTEGER,create_time INTEGER,message_content TEXT);INSERT INTO {table2} VALUES(1,1,{start+10},'今天讨论课程安排。');"
encrypted_db(account/'message/message_0.db',sql,key,salt)
encrypted_db(root/'fixture-update.dat',sql+f"INSERT INTO {table} VALUES(3,1,{start+30},'请提交新增实验作业。');",key,salt)
atomic_json(root/'fixture-connection.json',{'db_dir':str(account),'keys':{'contact/contact.db':key.hex(),'message/message_0.db':key.hex()}})
atomic_json(root/'fixture-settings.json',{'directory':str(account),'connection_file':str(root/'fixture-connection.json'),'chat':chat,'other':other,'since':start,'until':now})
print('Synthetic text-only encrypted input and later-message revision prepared')
