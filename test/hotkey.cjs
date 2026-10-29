const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { BrowserWindow, globalShortcut } = require('electron');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = async (c) => {
  const out = path.join(c.dataRoot, 'logs/hotkey');
  fs.mkdirSync(out, { recursive: true });
  const checks = [];
  const save = (value) =>
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(value, null, 2));
  const visible = () => c.native.api.visible(c.native.hwnd(c.widget));
  const onTop = () =>
    c.widget.isAlwaysOnTop() && !!(Number(c.native.api.getStyle(c.native.hwnd(c.widget), -20)) & 8);
  const until = async (fn) => {
    for (let i = 0; i < 1800; i++) {
      if (fn()) return;
      await wait(100);
    }
    throw Error('等待快捷键超时');
  };
  try {
    assert.equal(c.visibilityShortcut.status().registered, true);
    assert.equal(globalShortcut.isRegistered('Control+T'), true);
    checks.push('真实 Electron 全局 Ctrl+T 注册成功');
    const tasks = fs.readFileSync(c.repo.file);
    if (process.argv.includes('--hotkey-live-test')) {
      c.hideWidget();
      await c.openManager('window');
      const manager = BrowserWindow.getAllWindows().find((w) => w !== c.widget);
      manager.setTitle('WS · Ctrl+T 快捷键验证');
      save({ phase: 'waiting-show', checks });
      await until(() => !c.snapshot().hidden && c.config.value.mode === 'topmost' && visible());
      assert.ok(onTop());
      checks.push('实际系统按键：第一次 Ctrl+T 显示且拥有 Windows 置顶标志');
      save({ phase: 'waiting-hide', checks });
      await until(() => c.snapshot().hidden && !visible());
      checks.push('实际系统按键：第二次 Ctrl+T 隐藏');
    } else {
      c.visibilityShortcut.toggle();
      await wait(180);
      assert.ok(visible());
      assert.ok(onTop());
      assert.equal(c.snapshot().hidden, false);
      checks.push('第一次触发显示置顶，Windows WS_EX_TOPMOST 与 Electron 状态一致');
      c.visibilityShortcut.toggle();
      assert.equal(visible(), false);
      assert.equal(c.snapshot().hidden, true);
      checks.push('再次触发隐藏');
      c.visibilityShortcut.toggle();
      assert.ok(visible());
      c.hideWidget();
      c.visibilityShortcut.toggle();
      assert.ok(visible());
      checks.push('重复切换及托盘手动隐藏后再呼出正常');
    }
    assert.ok(fs.readFileSync(c.repo.file).equals(tasks));
    checks.push('显示隐藏没有改动任务文件');
    c.visibilityShortcut.dispose();
    assert.equal(globalShortcut.isRegistered('Control+T'), false);
    checks.push('退出前释放自己的全局快捷键');
    save({
      version: c.app.getVersion(),
      packaged: c.app.isPackaged,
      phase: 'passed',
      checks,
      actual_system_keys: process.argv.includes('--hotkey-live-test'),
      remote_AI_called: false,
    });
    c.quit();
  } catch (error) {
    save({ phase: 'failed', checks, error: error.stack });
    c.app.exit(1);
  }
};
