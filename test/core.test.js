const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTask, mutate, groups, validate, today } = require('../src/core/tasks.cjs');
const { TaskRepository } = require('../src/core/storage.cjs');
const { defaults, configValidate } = require('../src/core/config.cjs');
const geo = require('../src/windows/geometry.cjs');
const { endpoint, testConnection } = require('../src/core/llm.cjs');
test('性能策略：正常、电池、遮挡、隐藏与锁屏（模拟状态）', () => {
  const { performancePolicy: p } = require('../src/core/performance.cjs');
  assert.equal(p({}).fps, 30);
  assert.equal(p({ battery: true }).fps, 12);
  for (const state of [
    { covered: true },
    { hidden: true },
    { locked: true },
    { animations: false },
    { battery: true, covered: true },
  ])
    assert.equal(p(state).paused, true);
  assert.equal(p({ mode: 'eco', fps: 8 }).fps, 8);
});
function document() {
  return { version: 1, tasks: [] };
}
function temp() {
  return fs.mkdtempSync(
    path.join(
      process.env.WS_PRIVATE_ROOT ? path.join(process.env.WS_PRIVATE_ROOT, 'temp') : os.tmpdir(),
      'ws-test-',
    ),
  );
}
test('普通任务跨日分组保留 ID、原始计划与截止日期，不复制', () => {
  let doc = mutate(document(), {
    type: 'add',
    task: { title: '作业', planDate: '2026-10-17', dueDate: '2026-10-18' },
  });
  const id = doc.tasks[0].id;
  const view = groups(doc, '2026-10-19');
  assert.equal(view.history.length, 1);
  assert.equal(view.history[0].id, id);
  assert.equal(doc.tasks.length, 1);
  assert.equal(doc.tasks[0].dueDate, '2026-10-18');
  doc = mutate(doc, { type: 'toggle', id });
  assert.equal(groups(doc, '2026-10-19', true).history.length, 0);
  doc = mutate(doc, { type: 'toggle', id });
  assert.equal(groups(doc, '2026-10-19').history[0].id, id);
});
test('每日重复实例独立完成并能撤销，普通状态不被当作重复规则', () => {
  let doc = mutate(document(), {
    type: 'add',
    task: { title: '阅读', planDate: '2026-10-17', repeat: 'daily' },
  });
  const id = doc.tasks[0].id;
  doc = mutate(doc, { type: 'toggle', id, date: '2026-10-18' });
  const view = groups(doc, '2026-10-19', true);
  assert.equal(view.today.length, 1);
  assert.equal(view.history.length, 1);
  assert.equal(view.completed.length, 1);
  assert.equal(doc.tasks.length, 1);
  doc = mutate(doc, { type: 'toggle', id, date: '2026-10-18' });
  assert.equal(groups(doc, '2026-10-19').history.length, 2);
});
test('新增、编辑、排序、删除与稳定字段', () => {
  let d = mutate(document(), { type: 'add', task: { title: 'A' } });
  d = mutate(d, { type: 'add', task: { title: 'B' } });
  const [a, b] = d.tasks;
  d = mutate(d, { type: 'edit', id: a.id, task: { title: 'AA', id: 'evil', createdAt: 'bad' } });
  assert.equal(d.tasks[0].createdAt, a.createdAt);
  assert.equal(d.tasks[0].id, a.id);
  d = mutate(d, { type: 'move', id: b.id, direction: -1 });
  assert.equal(groups(d).today[0].title, 'B');
  d = mutate(d, { type: 'delete', id: a.id });
  assert.equal(d.tasks.length, 1);
});
test('非法日期、重复 ID、未来 Schema 不得载入', () => {
  const t = createTask({ title: 'A' });
  assert.throws(() => validate({ version: 2, tasks: [] }));
  assert.throws(() => validate({ version: 1, tasks: [t, t] }));
  assert.throws(() => validate({ version: 1, tasks: [{ ...t, planDate: '2026-02-30' }] }));
  assert.throws(() => validate({ version: 1, tasks: [{ ...t, completed: true }] }));
});
test('外部编辑冲突拒绝覆盖，损坏文件保留原文，备份可恢复', () => {
  const dir = temp();
  const r = new TaskRepository(dir);
  try {
    let s = r.snapshot();
    r.apply({ type: 'add', task: { title: '本地' } }, s.revision);
    s = r.snapshot();
    const external = structuredClone(s.document);
    external.tasks[0].title = '外部';
    fs.writeFileSync(r.file, JSON.stringify(external));
    assert.throws(() => r.apply({ type: 'delete', id: external.tasks[0].id }, s.revision), /变化/);
    assert.equal(r.snapshot().document.tasks[0].title, '外部');
    fs.writeFileSync(r.file, '{ damaged');
    r.reload();
    assert.ok(r.error);
    assert.throws(() => r.apply({ type: 'add', task: { title: 'x' } }, r.revision));
    assert.equal(fs.readFileSync(r.file, 'utf8'), '{ damaged');
    const backup = fs.readdirSync(r.backups).find((f) => f.startsWith('tasks.json'));
    r.restore(backup);
    assert.equal(r.error, null);
  } finally {
    r.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('真实文件监听：外部保存后自动刷新', async () => {
  const dir = temp();
  const r = new TaskRepository(dir);
  try {
    const next = { version: 1, tasks: [createTask({ title: '来自编辑器' })] };
    const changed = new Promise((resolve, reject) => {
      r.once('change', resolve);
      setTimeout(() => reject(Error('监听超时')), 2000).unref();
    });
    fs.writeFileSync(r.file, JSON.stringify(next));
    await changed;
    assert.equal(r.snapshot().document.tasks[0].title, '来自编辑器');
  } finally {
    r.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('负坐标、吸附、工作区回退、显示器缩放后的相对位置', () => {
  const d = { id: 2, workArea: { x: -1920, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 };
  const primary = { id: 1, workArea: { x: 0, y: 0, width: 2560, height: 1400 }, scaleFactor: 1.25 };
  const b = { x: -410, y: 448, width: 400, height: 580 };
  assert.equal(geo.snapBounds(b, d.workArea).x, -400);
  const state = geo.remember(b, d);
  assert.deepEqual(geo.restore(state, [d, primary], primary), b);
  const disconnected = geo.restore(state, [primary], primary);
  assert.ok(disconnected.x >= 0);
  const smaller = { ...d, workArea: { x: -1280, y: 0, width: 1280, height: 720 } };
  const restored = geo.restore(state, [smaller], primary);
  assert.ok(
    restored.x >= -1280 && restored.x + restored.width <= 0 && restored.y + restored.height <= 720,
  );
});
test('配置禁止密钥、远程主题路径与越界数值', () => {
  assert.equal(configValidate(structuredClone(defaults)).version, 1);
  for (const change of [
    (c) => {
      c.llm.apiKey = 'secret';
    },
    (c) => {
      c.theme = '../x';
    },
    (c) => {
      c.appearance.fps = 900;
    },
    (c) => {
      c.width = NaN;
    },
  ]) {
    const c = structuredClone(defaults);
    change(c);
    assert.throws(() => configValidate(c));
  }
});
test('API 路径规范化与 HTTPS/重定向边界', () => {
  assert.equal(endpoint('https://example.com/v1/'), 'https://example.com/v1/chat/completions');
  assert.equal(endpoint('http://127.0.0.1:9999/v1'), 'http://127.0.0.1:9999/v1/chat/completions');
  assert.throws(() => endpoint('http://example.com/v1'));
  assert.throws(() => endpoint('https://user:key@example.com/v1'));
  assert.throws(() => endpoint('https://example.com/v1?api_key=x'));
});
test('本地 HTTP 推理服务：真实请求与错误分类（模拟供应商）', async () => {
  const http = require('node:http');
  let status = 200,
    body = { choices: [{ message: { content: 'OK' } }] },
    received;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (b) => (raw += b));
    req.on('end', () => {
      received = { url: req.url, body: JSON.parse(raw), auth: req.headers.authorization };
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const config = {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: 'fixture',
    timeout: 3,
    maxTokens: 8,
    temperature: 0,
  };
  try {
    assert.equal((await testConnection(config, 'fixture-secret')).ok, true);
    assert.equal(received.url, '/v1/chat/completions');
    assert.equal(received.auth, 'Bearer fixture-secret');
    assert.equal(received.body.messages[0].content, 'Reply with OK only.');
    for (const [code, kind] of [
      [401, '密钥无效'],
      [403, '密钥无效'],
      [429, '请求限流'],
      [503, '服务端错误'],
      [400, '接口不兼容'],
    ]) {
      status = code;
      body = { error: { message: 'fixture-secret' } };
      const result = await testConnection(config, 'fixture-secret');
      assert.equal(result.ok, false);
      assert.ok(result.kind.startsWith(kind));
      assert.ok(!JSON.stringify(result).includes('fixture-secret'));
    }
    status = 404;
    body = { error: { code: 'model_not_found' } };
    assert.equal((await testConnection(config, 'fixture-secret')).kind, '模型不存在');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
test('网络失败和超时分类（注入传输）', async () => {
  const c = { baseUrl: 'https://example.com/v1', model: 'fixture', timeout: 0.02 };
  assert.equal(
    (
      await testConnection(c, 'x', async () => {
        throw Error('x');
      })
    ).kind,
    '网络失败',
  );
  const r = await testConnection(
    c,
    'x',
    async (_u, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(Error('aborted'))),
      ),
  );
  assert.equal(r.kind, '超时');
});
