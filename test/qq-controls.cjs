const assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { BrowserWindow, shell, clipboard } = require('electron');
const { QQShell } = require('../src/core/qq-shell.cjs');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  for (let i = 0; i < 160; i++) {
    if (await fn()) return;
    await pause(100);
  }
  throw Error(label);
}
module.exports = async (c) => {
  const checks = [],
    out = path.join(c.dataRoot, 'validation/qq-controls');
  fs.mkdirSync(out, { recursive: true });
  const save = (f, v) => {
    f = path.join(c.dataRoot, f);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(v));
  };
  let own = [],
    launches = 0,
    stops = 0,
    opened = '';
  const hooks = {
    processes: async (stop) => {
      if (stop) {
        stops++;
        own = [];
      }
      return own;
    },
    request: async (port, route) => {
      if (port === 6099 && own.length)
        return {
          status: 200,
          value: {
            data:
              route === '/api/auth/login'
                ? { Credential: 'fixture' }
                : { isLogin: false, loginPhase: 'waiting_qrcode' },
          },
        };
      throw Error('fixture unavailable');
    },
    launch: () => {
      launches++;
      own = [{ pid: 123 }];
      const child = new (require('node:events').EventEmitter)();
      return child;
    },
  };
  try {
    save('qq/installation.json', { version: '6.3.2' });
    save('qq/client/QQ.exe', {});
    save('qq/shell/config/webui.json', {
      token: 'fixture-token',
      autoLoginAccount: 'fixture-account',
    });
    c.integration.qq = new QQShell(c.dataRoot, hooks);
    const config = (await c.integration.worker({ command: 'status' })).config;
    await c.integration.worker({
      command: 'save_config',
      config: {
        ...config,
        enabled: false,
        sources: [
          {
            id: 'qq-fixture',
            platform: 'qq',
            account_id: 'fixture-account',
            account_name: 'QQ 入口验收账号',
            db_dir: '',
            enabled: true,
          },
        ],
      },
    });
    await c.integration.refresh();
    await c.openManager('messages');
    const m = BrowserWindow.getAllWindows().find((w) => w !== c.widget),
      js = (code) => m.webContents.executeJavaScript(code, true);
    await until(() => js('!!document.querySelector("#qq-start")'), 'QQ controls rendered');
    for (const id of [
      'qq-start',
      'qq-stop',
      'qq-restart',
      'qq-login',
      'qq-refresh',
      'qq-switch',
      'qq-bind',
      'qq-copy-token',
    ])
      assert.ok(await js(`!!document.getElementById(${JSON.stringify(id)})`));
    checks.push('QQ controls and copy-token button rendered in actual management page');
    const originalWrite = clipboard.writeText;
    let copied = '';
    clipboard.writeText = (value) => {
      copied = value;
    };
    try {
      const denied = await c.widget.webContents.executeJavaScript(
        'window.ws.integration("copy_qq_login_token")',
      );
      assert.equal(denied.ok, false);
      assert.equal(copied, '');
      const reply = await js('window.ws.integration("copy_qq_login_token")');
      assert.equal(reply.ok, true);
      assert.equal(reply.value.copied, true);
      assert.equal(copied, 'fixture-token');
      assert.ok(!JSON.stringify(reply).includes('fixture-token'));
      copied = '';
      await js('document.querySelector("#qq-copy-token").click()');
      await until(() => copied === 'fixture-token', 'copy button');
      assert.ok(!(await js('document.body.innerText.includes("fixture-token")')));
    } finally {
      clipboard.writeText = originalWrite;
    }
    checks.push(
      'Copy button writes current token only to clipboard, never IPC response or page text (clipboard intercepted)',
    );
    await js('document.querySelector("#qq-start").click()');
    await until(() => !c.integration.running && launches === 1, 'start');
    await js('document.querySelector("#qq-refresh").click()');
    await pause(400);
    assert.equal(launches, 1);
    checks.push('Refresh does not launch another backend');
    await js('document.querySelector("#qq-stop").click()');
    await until(() => !c.integration.running && c.integration.qq.isPaused(), 'stop');
    assert.equal(own.length, 0);
    const rebuilt = new QQShell(c.dataRoot, hooks);
    await assert.rejects(rebuilt.start(), /暂停/);
    checks.push('Exit persists pause across controller recreation');
    const originalOpen = shell.openExternal;
    shell.openExternal = async (url) => {
      opened = url;
    };
    await js('document.querySelector("#qq-switch").click()');
    await until(() => js('document.querySelector("#task-dialog").open'), 'switch dialog');
    await js(
      'Array.from(document.querySelector("#task-dialog").querySelectorAll("button")).find(b=>b.textContent==="确认").click()',
    );
    await until(() => !!opened && !c.integration.running, 'switch');
    assert.ok(opened.startsWith('http://127.0.0.1:6099/'));
    assert.equal(c.integration.qq.session().switching, true);
    assert.equal(c.integration.qq.isPaused(), true);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(c.dataRoot, 'qq/shell/config/webui.json')))
        .autoLoginAccount,
      '',
    );
    checks.push(
      'Switch ends prior session, opens local login and waits for account binding; external browser handoff captured',
    );
    opened = '';
    await js('document.querySelector("#qq-restart").click()');
    await until(() => !c.integration.running && stops >= 3, 'restart');
    await until(() => opened.includes('token=fixture-token'), 'restart opens token URL');
    shell.openExternal = originalOpen;
    assert.equal(c.integration.qq.isPaused(), true);
    checks.push('Restart during switch keeps collection paused');
    await js('document.querySelector("#qq-stop").click()');
    await until(() => !c.integration.running && own.length === 0, 'final stop');
    await until(
      () => js('document.body.innerText.includes("QQ 后台已退出，QQ 自动采集已暂停")'),
      'paused status rendered',
    );
    await pause(300);
    await js('document.querySelector("[data-source-id]").scrollIntoView({block:"center"})');
    fs.writeFileSync(
      path.join(out, 'QQ退出与切换入口.png'),
      (await m.webContents.capturePage()).toPNG(),
    );
    fs.writeFileSync(
      path.join(out, 'result.json'),
      JSON.stringify(
        {
          pass: true,
          transport:
            'Injected QQ process and HTTP transport; real packaged UI, IPC, frozen worker and state files',
          checks,
        },
        null,
        2,
      ),
    );
    c.quit();
  } catch (e) {
    fs.writeFileSync(
      path.join(out, 'result.json'),
      JSON.stringify({ pass: false, error: e.stack, checks }, null, 2),
    );
    c.app.exit(1);
  }
};
