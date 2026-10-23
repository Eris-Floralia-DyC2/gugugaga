import sqlite3
import unittest
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import state
from wechat import WeChat

class ContactNames(unittest.TestCase):
    def reader(self, fields, rows):
        reader=WeChat.__new__(WeChat)
        def db(rel):
            self.assertEqual(rel,'contact/contact.db')
            c=sqlite3.connect(':memory:');c.row_factory=sqlite3.Row
            c.execute('CREATE TABLE contact ('+fields+')')
            c.executemany('INSERT INTO contact VALUES ('+','.join('?' for _ in rows[0])+')',rows)
            return c
        reader.db=db
        return reader
    def test_actual_fields_priority_aliases_and_stable_ids(self):
        r=self.reader('username,nick_name,remark',[
            ('friend','朋友昵称','我的备注'),('one@chatroom','群原名','我的群备注'),
            ('two@chatroom','无备注群','  '),('unknown','',''),('notifymessage','通知','')])
        out=r.conversations();self.assertEqual(len(out),4)
        self.assertEqual([x['name'] for x in out],['我的备注','我的群备注','无备注群','unknown'])
        self.assertEqual(out[0]['aliases'],['我的备注','朋友昵称'])
        self.assertEqual(out[1]['id'],'one@chatroom')
        self.assertEqual(out[1]['name_source'],'remark')
        self.assertEqual(out[2]['name_source'],'nickname')
        self.assertEqual(out[3]['name_source'],'identifier')
    def test_unavailable_remark_column_does_not_invent_remark(self):
        out=self.reader('username,nick_name',[('one@chatroom','可读取群名')]).conversations()
        self.assertEqual(out[0]['name'],'可读取群名');self.assertEqual(out[0]['remark'],'')
