"""Audited upstream image scanner: read-only handles, no raw key logging, full image validation."""
import ctypes
from ctypes import wintypes as wt
import hashlib
import time
from PIL import Image
from state import UserError
from decode_image import decrypt_dat_file
import find_image_key as original


def scan(state,source):
    original.print=lambda *a,**k:None
    kernel=original.kernel32
    kernel.OpenProcess.argtypes=[wt.DWORD,wt.BOOL,wt.DWORD];kernel.OpenProcess.restype=wt.HANDLE
    kernel.CloseHandle.argtypes=[wt.HANDLE];kernel.CloseHandle.restype=wt.BOOL
    kernel.VirtualQueryEx.argtypes=[wt.HANDLE,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_size_t];kernel.VirtualQueryEx.restype=ctypes.c_size_t
    kernel.ReadProcessMemory.argtypes=[wt.HANDLE,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_size_t,ctypes.POINTER(ctypes.c_size_t)]
    from pathlib import Path
    base=Path(source['db_dir']).parent/'msg/attach'
    samples=[]
    from ws_workflow import saved_selection
    for chat in [v['chat_id'] for v in saved_selection(state)['selected'] if v['source_id']==source['id']]:
        folder=base/hashlib.md5(chat.encode()).hexdigest()
        for path in folder.glob('*/Img/*_t.dat'):
            with path.open('rb') as f:raw=f.read()
            if raw[:6]==b'\x07\x08V2\x08\x07' and len(raw)>32:
                xor=raw[-2]^0xff
                if raw[-1]^0xd9==xor:samples.append((path,raw[15:31],xor))
    if not samples: raise UserError('所选群无可验证的 V2 JPEG 缩略图，不能猜测媒体密钥')
    pids=original.get_wechat_pids()
    if not pids: raise UserError('微信未运行')
    original._deadline=time.monotonic()+150
    for pid in pids:
        for path,block,xor in samples[:2]:
            key=original.scan_memory_for_aes_key(pid,block)
            if not key: continue
            target=state.root/'cache/attachments/media-key-test.image'
            try:
                result,_=decrypt_dat_file(str(path),str(target),key.encode()[:16],xor)
                if not result:continue
                with Image.open(target) as image:image.verify()
                state.secret('media-'+source['id'],{'aes_key':key.encode()[:16].hex(),'xor_key':xor},write=True)
                return {'validated':True,'sample_count':1}
            except Exception:
                pass
            finally:
                target.unlink(missing_ok=True)
    raise UserError('未找到可完整验证图片的媒体密钥；文本采集仍可继续')
