# Modified for WS integration; see NOTICE.md for changes and upstream attribution.
# Original third-party license terms remain applicable.
"""Local state. Secrets use current-user Windows DPAPI; never print secrets."""
import base64
import ctypes
import json
import os
import tempfile
import threading
from pathlib import Path
from datetime import datetime, timezone, timedelta

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('WS_PRIVATE_ROOT') or os.environ.get('WECHAT_TASKS_DATA') or (ROOT.parents[1] / 'WS-Private')).resolve()
TZ = timezone(timedelta(hours=8))
LOCK = threading.RLock()
DEFAULTS = {
    'version': 1, 'db_dir': '', 'groups': [], 'identity': '',
    'model': 'deepseek-flash', 'interval_minutes': 30, 'initial_days': 7,
    'enabled': False, 'ws_root': '',
}

class UserError(Exception):
    pass

def now():
    return datetime.now(TZ)

def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

def read_json(path, default=None):
    if not Path(path).exists():
        return default
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))

def config():
    return {**DEFAULTS, **read_json(DATA / 'config.json', {})}

def save_config(value):
    if set(value) - set(DEFAULTS):
        raise UserError('存在未知配置字段')
    c = {**DEFAULTS, **value}
    if (type(c['enabled']) is not bool or type(c['interval_minutes']) is not int
            or not 5 <= c['interval_minutes'] <= 1440
            or type(c['initial_days']) is not int or not 1 <= c['initial_days'] <= 30):
        raise UserError('同步间隔应为 5–1440 分钟，首次回溯应为 1–30 天')
    if (not isinstance(c['groups'], list) or len(c['groups']) > 50
            or any(not isinstance(g, str) or not g.endswith('@chatroom') or len(g) > 150 for g in c['groups'])):
        raise UserError('请选择有效微信群，最多 50 个')
    if not isinstance(c['identity'], str) or len(c['identity']) > 2000:
        raise UserError('身份说明过长')
    if not isinstance(c['model'], str) or not c['model'].strip() or len(c['model']) > 100:
        raise UserError('模型名称无效')
    if c['db_dir'] and (not Path(c['db_dir']).is_dir() or Path(c['db_dir']).name != 'db_storage'):
        raise UserError('数据库目录必须是现有的 db_storage 文件夹')
    atomic_json(DATA / 'config.json', c)
    return c

def dpapi(raw, decrypt=False):
    if os.name != 'nt':
        raise UserError('凭据保护需要 Windows')
    class Blob(ctypes.Structure):
        _fields_ = [('size', ctypes.c_uint32), ('data', ctypes.POINTER(ctypes.c_ubyte))]
    buf = ctypes.create_string_buffer(raw)
    inp = Blob(len(raw), ctypes.cast(buf, ctypes.POINTER(ctypes.c_ubyte)))
    out = Blob()
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    function = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                         ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(Blob)]
    function.restype = ctypes.c_int
    if not function(ctypes.byref(inp), None, None, None, None, 1, ctypes.byref(out)):
        raise UserError('Windows 凭据加密或解密失败；请使用原 Windows 账户重新配置')
    try:
        return ctypes.string_at(out.data, out.size)
    finally:
        kernel.LocalFree(out.data)

def set_secret(name, value):
    if name not in ('keys', 'deepseek'):
        raise UserError('未知凭据')
    atomic_json(DATA / (name + '.protected.json'), {
        'version': 1, 'ciphertext': base64.b64encode(dpapi(json.dumps(value).encode())).decode()
    })

def get_secret(name, default=None):
    value = read_json(DATA / (name + '.protected.json'))
    if value is None:
        return default
    return json.loads(dpapi(base64.b64decode(value['ciphertext']), True))

def discover():
    roots = [Path.home() / 'Documents' / 'xwechat_files', Path.home() / 'xwechat_files']
    for drive in ('C:', 'D:', 'E:', 'F:'):
        roots.append(Path(drive + '/xwechat_files'))
    found = []
    for root in roots:
        if root.is_dir():
            found += [str(p.resolve()) for p in root.glob('*/db_storage') if p.is_dir()]
    return sorted(set(found))
