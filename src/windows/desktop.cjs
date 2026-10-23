const koffi = require('koffi');
const u = koffi.load('user32.dll');
const RECT = koffi.struct('WS_RECT', { left: 'int', top: 'int', right: 'int', bottom: 'int' });
const POINT = koffi.struct('WS_POINT', { x: 'int', y: 'int' });
const api = {
  find: u.func('void * __stdcall FindWindowW(str16, str16)'),
  findEx: u.func('void * __stdcall FindWindowExW(void *, void *, str16, str16)'),
  parent: u.func('void * __stdcall GetParent(void *)'),
  setParent: u.func('void * __stdcall SetParent(void *, void *)'),
  getStyle: u.func('intptr_t __stdcall GetWindowLongPtrW(void *, int)'),
  setStyle: u.func('intptr_t __stdcall SetWindowLongPtrW(void *, int, intptr_t)'),
  pos: u.func('bool __stdcall SetWindowPos(void *, intptr_t, int, int, int, int, uint32)'),
  rect: u.func('bool __stdcall GetWindowRect(void *, _Out_ WS_RECT *)'),
  toClient: u.func('bool __stdcall ScreenToClient(void *, _Inout_ WS_POINT *)'),
  valid: u.func('bool __stdcall IsWindow(void *)'),
  visible: u.func('bool __stdcall IsWindowVisible(void *)'),
  iconic: u.func('bool __stdcall IsIconic(void *)'),
  show: u.func('bool __stdcall ShowWindow(void *, int)'),
  key: u.func('int16 __stdcall GetAsyncKeyState(int)'),
  top: u.func('void * __stdcall GetTopWindow(void *)'),
  next: u.func('void * __stdcall GetWindow(void *, uint32)'),
  foreground: u.func('void * __stdcall GetForegroundWindow()'),
  send: u.func(
    'intptr_t __stdcall SendMessageTimeoutW(void *, uint32, uintptr_t, intptr_t, uint32, uint32, _Out_ uintptr_t *)',
  ),
};
// Electron's native handle is an eight-byte HWND value, not a pointer to another HWND.
function hwnd(win) {
  return koffi.decode(win.getNativeWindowHandle(), 'uintptr_t');
}
function rect(h) {
  const r = {};
  if (!api.rect(h, r)) throw new Error('无法读取窗口坐标');
  return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
}
function shellHost() {
  const prog = api.find('Progman', null);
  if (!prog) return null;
  if (api.findEx(prog, null, 'SHELLDLL_DefView', null)) return prog;
  let w = null;
  while ((w = api.findEx(null, w, 'WorkerW', null))) {
    if (api.findEx(w, null, 'SHELLDLL_DefView', null)) return w;
  }
  return prog;
}
function setBounds(win, bounds) {
  const h = hwnd(win);
  const p = api.parent(h);
  const point = { x: bounds.x, y: bounds.y };
  if (p) api.toClient(p, point);
  api.pos(h, 0, point.x, point.y, bounds.width, bounds.height, 0x0010 | 0x0004);
}
function attach(win, mode, bounds) {
  const h = hwnd(win);
  const style = Number(api.getStyle(h, -16));
  if (mode === 'desktop') {
    const host = shellHost();
    if (!host) throw new Error('Windows Explorer 桌面尚未就绪');
    api.setStyle(h, -16, (style & ~0x80000000) | 0x40000000);
    api.setParent(h, host);
    setBounds(win, bounds);
    api.pos(h, 0, 0, 0, 0, 0, 0x0010 | 0x0001 | 0x0002 | 0x0020 | 0x0040);
    return { mode, host: String(koffi.address(host)) };
  }
  api.setParent(h, null);
  api.setStyle(h, -16, (style & ~0x40000000) | 0x80000000);
  api.pos(h, -1, bounds.x, bounds.y, bounds.width, bounds.height, 0x0010 | 0x0020 | 0x0040);
  return { mode, host: null };
}
function diagnostics(win) {
  const h = hwnd(win);
  const p = api.parent(h);
  return {
    hwnd: String(h),
    parent: p ? String(koffi.address(p)) : null,
    visible: api.visible(h),
    minimized: api.iconic(h),
    bounds: rect(h),
    style: String(api.getStyle(h, -16)),
  };
}
function same(a, b) {
  return String(a ? koffi.address(a) : 0) === String(b ? koffi.address(b) : 0);
}
function subtract(a, b) {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y),
    r = Math.min(a.x + a.width, b.x + b.width),
    bt = Math.min(a.y + a.height, b.y + b.height);
  if (x >= r || y >= bt) return [a];
  return [
    { x: a.x, y: a.y, width: a.width, height: y - a.y },
    { x: a.x, y: bt, width: a.width, height: a.y + a.height - bt },
    { x: a.x, y, width: x - a.x, height: bt - y },
    { x: r, y, width: a.x + a.width - r, height: bt - y },
  ].filter((v) => v.width > 0 && v.height > 0);
}
let dwm;
try {
  dwm = koffi
    .load('dwmapi.dll')
    .func('int __stdcall DwmGetWindowAttribute(void *, uint32, _Out_ int *, uint32)');
} catch {}
function occluded(win) {
  const target = rect(hwnd(win));
  let remaining = [target];
  let w = api.top(null);
  let n = 0;
  const host = shellHost();
  while (w && n++ < 256) {
    if (same(w, host) || same(w, hwnd(win))) break;
    if (!same(w, hwnd(win)) && api.visible(w) && !api.iconic(w)) {
      const ex = Number(api.getStyle(w, -20));
      const cloaked = [0];
      if (dwm) dwm(w, 14, cloaked, 4);
      if (!(ex & 0x80000) && !cloaked[0]) {
        try {
          const r = rect(w);
          const inset = { x: r.x + 12, y: r.y + 12, width: r.width - 24, height: r.height - 24 };
          remaining = remaining.flatMap((a) => subtract(a, inset));
          if (!remaining.length) return true;
        } catch {}
      }
    }
    w = api.next(w, 2);
  }
  return false;
}
module.exports = { api, hwnd, rect, shellHost, setBounds, attach, diagnostics, occluded, subtract };
