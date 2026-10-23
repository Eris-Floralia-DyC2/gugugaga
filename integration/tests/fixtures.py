import struct
import sqlite3
import hmac
import hashlib
from Crypto.Cipher import AES
import wechat_reader as reader

def reserve80(raw):
    """Move small leaf-page cells into SQLite's 4016-byte usable space."""
    out=bytearray(raw)
    out[20]=80
    for i in range(0,len(out),4096):
        p=bytearray(out[i:i+4096]); start=100 if i==0 else 0
        if p[start] not in (0,13):
            raise AssertionError('Fixture only supports table leaves')
        if p[start]==13:
            count=struct.unpack('>H',p[start+3:start+5])[0]
            if count:
                content=struct.unpack('>H',p[start+5:start+7])[0]
                p[content-80:4016]=p[content:4096]
                p[4016:]=bytes(80)
                p[start+5:start+7]=struct.pack('>H',content-80)
                for j in range(count):
                    offset=start+8+2*j
                    pos=struct.unpack('>H',p[offset:offset+2])[0]
                    p[offset:offset+2]=struct.pack('>H',pos-80)
        out[i:i+4096]=p
    return bytes(out)

def encrypt_page(plain, pgno,key,salt):
    start=16 if pgno==1 else 0
    iv=bytes([pgno%255])*16
    ciphertext=AES.new(key,AES.MODE_CBC,iv).encrypt(plain[start:-80])
    base=(salt if pgno==1 else b'')+ciphertext+iv
    mac=hmac.new(reader.mac_key(key,salt),base[start:]+struct.pack('<I',pgno),hashlib.sha512).digest()
    return base+mac

def encrypted_db(path, sql, key, salt):
    path.parent.mkdir(parents=True,exist_ok=True)
    plain=path.with_suffix('.plain')
    con=sqlite3.connect(plain)
    con.execute('PRAGMA page_size=4096')
    con.executescript(sql)
    con.commit();con.close()
    raw=reserve80(plain.read_bytes())
    plain.write_bytes(raw)
    con=sqlite3.connect(plain)
    try:
        assert con.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    finally:
        con.close()
    encrypted=b''.join(encrypt_page(raw[i:i+4096],i//4096+1,key,salt) for i in range(0,len(raw),4096))
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_bytes(encrypted)
    return raw

def wal_file(path, frames):
    header=struct.pack('>IIIIII',0x377f0682,3007000,4096,0,11,22)
    state=reader.checksum(header)
    out=header+struct.pack('>II',*state)
    for pgno,commit,page in frames:
        first=struct.pack('>II',pgno,commit)
        state=reader.checksum(first+page,state)
        out+=first+struct.pack('>II',11,22)+struct.pack('>II',*state)+page
    path.write_bytes(out)

