const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { EventEmitter } = require('node:events');
const { QQShell } = require('../src/core/qq-shell.cjs');
test('登录链接读取最新 Token 并正确编码，缺失 Token 不生成无效链接', (t) => {
  const f = fixture(t);
  f.save('qq/shell/config/webui.json', { token: 'fixture +&=?中文' });
  assert.equal(new URL(f.q.loginUrl()).searchParams.get('token'), 'fixture +&=?中文');
  f.save('qq/shell/config/webui.json', { token: 'updated-fixture' });
  assert.equal(f.q.loginToken(), 'updated-fixture');
  f.save('qq/shell/config/webui.json', {});
  assert.throws(() => f.q.loginUrl(), /尚未准备好/);
  fs.writeFileSync(
    path.join(f.root, 'qq/shell/config/webui.json'),
    '{"token":"DO_NOT_SHOW_FIXTURE_SECRET',
  );
  assert.throws(
    () => f.q.loginToken(),
    (e) => e.message.includes('暂时无法读取') && !e.message.includes('DO_NOT_SHOW'),
  );
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const save = (name, value) => {
    const f = path.join(root, name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(value));
  };
  save('qq/installation.json', { version: '6.3.2', resource_relative: 'resources/app' });
  save('qq/client/QQ.exe', {});
  save('qq/shell/config/webui.json', { token: 'fixture-token', autoLoginAccount: '123' });
  save('qq/profile/.qq-chat-exporter/security.json', { accessToken: 'fixture' });
  let own = [],
    launches = 0,
    stops = 0,
    api = 'down',
    web = 'down',
    calls = [];
  const hooks = {
    processes: async (stop) => {
      if (stop) {
        stops++;
        own = [];
      }
      return own;
    },
    request: async (port, route, headers, body) => {
      calls.push({ port, route, body });
      if (port === 40653 && api === 'ready')
        return {
          status: 200,
          value: {
            success: true,
            data: {
              napcat: {
                online: true,
                workingEnv: 'shell',
                selfInfo: { uin: '123', nick: 'fixture' },
              },
            },
          },
        };
      if (port === 6099 && web === 'waiting')
        return route === '/api/auth/login'
          ? { status: 200, value: { data: { Credential: 'fixture-credential' } } }
          : { status: 200, value: { data: { isLogin: false, loginPhase: 'waiting_qrcode' } } };
      throw Object.assign(Error('refused'), { code: 'ECONNREFUSED' });
    },
    launch: () => {
      launches++;
      own = [{ pid: 123 }];
      const c = new EventEmitter();
      c.stdout = new EventEmitter();
      c.stderr = new EventEmitter();
      return c;
    },
  };
  return {
    root,
    save,
    q: new QQShell(root, hooks),
    hooks,
    setOwn: (v) => (own = v),
    setApi: (v) => (api = v),
    setWeb: (v) => (web = v),
    get launches() {
      return launches;
    },
    get stops() {
      return stops;
    },
    calls,
  };
}
test('退出终止全部专用实例并持久暂停，重建会话对象后也不自动启动', async (t) => {
  const f = fixture(t);
  f.setOwn([{ pid: 1 }, { pid: 2 }]);
  await f.q.stop();
  assert.equal(f.stops, 1);
  assert.equal((await f.q.status()).state, 'stopped');
  const restarted = new QQShell(f.root, f.hooks);
  await assert.rejects(restarted.start(), /暂停/);
  assert.equal(f.launches, 0);
});
test('进程残留但接口未就绪时不叠加启动，显式重启才重新拉起', async (t) => {
  const f = fixture(t);
  f.setOwn([{ pid: 1 }, { pid: 2 }]);
  assert.equal((await f.q.status()).state, 'unavailable');
  await assert.rejects(f.q.start({ explicit: true }), /采集服务未就绪/);
  assert.equal(f.launches, 0);
  await f.q.restart();
  assert.equal(f.stops, 1);
  assert.equal(f.launches, 1);
});
test('并发启动合并为一次，登录页状态使用真实 POST 路径', async (t) => {
  const f = fixture(t);
  await Promise.all([f.q.start({ explicit: true }), f.q.start({ explicit: true })]);
  assert.equal(f.launches, 1);
  f.setWeb('waiting');
  await f.q.start({ explicit: true });
  assert.equal(f.launches, 1);
  assert.ok(f.calls.some((c) => c.route === '/api/QQLogin/CheckLoginStatus' && c.body));
});
test('切换账号启动不自动恢复采集，且清除快速登录账号而保留网页 Token', async (t) => {
  const f = fixture(t);
  await f.q.restart({ forSwitch: true, forceLogin: true });
  const web = JSON.parse(fs.readFileSync(path.join(f.root, 'qq/shell/config/webui.json')));
  assert.equal(web.autoLoginAccount, '');
  assert.equal(web.token, 'fixture-token');
  assert.equal(f.q.isPaused(), true);
  await assert.rejects(f.q.start(), /暂停/);
});
test('仅检测连接不会启动 QQ，真实在线状态与进程存在分别判断', async (t) => {
  const f = fixture(t);
  assert.equal((await f.q.status()).state, 'not_running');
  assert.equal(f.launches, 0);
  f.setApi('ready');
  f.setOwn([{ pid: 123 }]);
  assert.equal((await f.q.status()).state, 'ready');
  assert.equal(f.launches, 0);
});
