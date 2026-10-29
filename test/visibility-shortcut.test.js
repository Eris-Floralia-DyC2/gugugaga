const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createVisibilityShortcut } = require('../src/core/visibility-shortcut.cjs');
function setup({ occupied = false, initiallyTopmost = false } = {}) {
  const callbacks = new Map([['Control+Alt+P', () => {}]]);
  let visible = true,
    topmost = initiallyTopmost,
    shown = 0,
    hidden = 0;
  const errors = [];
  const shortcuts = {
    register: (key, fn) => {
      if (occupied) return false;
      callbacks.set(key, fn);
      return true;
    },
    unregister: (key) => callbacks.delete(key),
  };
  const controller = createVisibilityShortcut({
    shortcuts,
    isShown: () => visible && topmost,
    showTopmost: () => {
      visible = true;
      topmost = true;
      shown++;
    },
    hide: () => {
      visible = false;
      hidden++;
    },
    onError: (e) => errors.push(e),
  });
  return {
    controller,
    callbacks,
    errors,
    state: () => ({ visible, topmost, shown, hidden }),
    press: () => callbacks.get('Control+T')?.(),
    manualHide: () => {
      visible = false;
    },
    desktop: () => {
      visible = true;
      topmost = false;
    },
  };
}
test('Ctrl+T 第一次显示置顶，再次隐藏，继续按键可重复切换', () => {
  const f = setup();
  assert.equal(f.controller.register(), true);
  f.press();
  assert.deepEqual(f.state(), { visible: true, topmost: true, shown: 1, hidden: 0 });
  f.press();
  assert.equal(f.state().visible, false);
  f.press();
  assert.equal(f.state().visible, true);
  assert.equal(f.controller.status().registered, true);
});
test('启动时已经置顶，第一次快捷键仍然显示；手动隐藏或切换桌面模式后可再次呼出', () => {
  const f = setup({ initiallyTopmost: true });
  f.controller.register();
  f.press();
  assert.equal(f.state().visible, true);
  f.manualHide();
  f.press();
  assert.equal(f.state().visible, true);
  f.desktop();
  f.press();
  assert.equal(f.state().topmost, true);
});
test('占用时返回可读状态，不覆盖其他快捷键；退出仅释放自身且忽略已排队旧回调', () => {
  const busy = setup({ occupied: true });
  assert.equal(busy.controller.register(), false);
  assert.match(busy.controller.status().reason, /占用/);
  assert.equal(busy.callbacks.size, 1);
  const f = setup();
  f.controller.register();
  const queued = f.callbacks.get('Control+T');
  f.controller.dispose();
  f.controller.dispose();
  queued();
  assert.equal(f.state().shown, 0);
  assert.ok(f.callbacks.has('Control+Alt+P'));
  assert.equal(f.controller.status().registered, false);
});
test('注册异常和显示失败不会崩溃，后续可以重试', () => {
  const errors = [];
  let callback,
    fail = true,
    shown = 0;
  const controller = createVisibilityShortcut({
    shortcuts: {
      register: (_, fn) => {
        callback = fn;
        return true;
      },
      unregister: () => {},
    },
    isShown: () => false,
    showTopmost: () => {
      if (fail) throw Error('模拟窗口暂不可用');
      shown++;
    },
    hide: () => {},
    onError: (e) => errors.push(e),
  });
  controller.register();
  callback();
  assert.equal(errors.length, 1);
  fail = false;
  callback();
  assert.equal(shown, 1);
  const broken = createVisibilityShortcut({
    shortcuts: {
      register: () => {
        throw Error('模拟注册失败');
      },
    },
    showTopmost: () => {},
    hide: () => {},
    isShown: () => false,
  });
  assert.equal(broken.register(), false);
  assert.match(broken.status().reason, /失败/);
});
