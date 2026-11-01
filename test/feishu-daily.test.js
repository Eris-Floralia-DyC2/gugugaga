const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { FeishuDaily, scheduleTarget } = require('../src/core/feishu-daily.cjs');
test('飞书调度按本机日期：21点、修改时间、午夜和闰日', () => {
  assert.equal(scheduleTarget(new Date(2026, 10, 1, 20, 59), '21:00'), '2026-10-31');
  assert.equal(scheduleTarget(new Date(2026, 10, 1, 21), '21:00'), '2026-11-01');
  assert.equal(scheduleTarget(new Date(2026, 10, 1, 9), '08:00'), '2026-11-01');
  assert.equal(scheduleTarget(new Date(2028, 2, 1, 0), '21:00'), '2028-02-29');
});
test('飞书独立于其他消息计划；失败重试、暂停、重启幂等和改时生效', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-daily-'));
  fs.mkdirSync(path.join(root, 'config'));
  fs.mkdirSync(path.join(root, 'state'));
  const c = {
    enabled: true,
    daily_time: '21:00',
    source: { account_id: 'user' },
    groups: [{ id: 'oc_a', start_date: '2026-11-01' }],
  };
  const write = () =>
    fs.writeFileSync(path.join(root, 'config/feishu-daily.json'), JSON.stringify(c));
  write();
  let count = 0,
    fail = true;
  const owner = {
    dataRoot: root,
    config: { value: { llm: { model: 'reuse' } } },
    credentials: { get: () => 'test-fixture' },
    operation: async (_, fn) => fn(),
    emit: () => {},
    worker: async (request) => {
      assert.equal(request.command, 'feishu_daily_run');
      assert.equal(request.llm.model, 'reuse');
      count++;
      return {
        ok: !fail,
        results: fail ? [{ status: 'failed', reason: '断网' }] : [],
      };
    },
  };
  let feature = new FeishuDaily(owner);
  try {
    const now = new Date(2026, 10, 1, 21);
    await feature.tick(now);
    assert.equal(count, 1);
    assert.ok(feature.nextRetry > Date.now());
    await feature.tick(now);
    assert.equal(count, 1);
    fail = false;
    feature.nextRetry = 0;
    await feature.tick(now);
    assert.equal(count, 2);
    feature = new FeishuDaily(owner);
    await feature.tick(now);
    assert.equal(count, 2);
    c.daily_time = '20:00';
    write();
    await feature.tick(now);
    assert.equal(count, 3);
    c.enabled = false;
    write();
    await feature.tick(new Date(2026, 10, 2, 21));
    assert.equal(count, 3);
    owner.running = true;
    c.enabled = true;
    write();
    await feature.tick(now);
    assert.equal(count, 3);
  } finally {
    feature.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
