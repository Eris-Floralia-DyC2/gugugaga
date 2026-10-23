const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskRepository, atomicWrite } = require('../src/core/storage.cjs');
const { reconcile, keyFor } = require('../src/core/group-confirmations.cjs');
const { createImporter } = require('../src/core/task-api.cjs');

function scenario(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-confirm-'));
  const repo = new TaskRepository(dir);
  const d = {
    platform: 'qq',
    accountId: '123',
    groupId: 'group:456',
    sourceId: 'qq-source',
    name: '课程',
    day: '2026-10-22',
    needed: true,
    incomplete: false,
    useful: false,
    analysisComplete: true,
  };
  d.key = keyFor(d);
  try {
    fn({ dir, repo, d, run: (ds = [d]) => reconcile(repo, dir, ds) });
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('同群同日跨批次和重启只保留一条确认任务', () =>
  scenario(({ dir, repo, d, run }) => {
    run();
    const id = repo.doc.tasks[0].id;
    for (let i = 0; i < 10; i++) reconcile(repo, dir, [{ ...d, incomplete: i % 2 === 0 }]);
    assert.equal(repo.doc.tasks.length, 1);
    assert.equal(repo.doc.tasks[0].id, id);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dir, 'state/group-confirmations.json')))[d.key].state,
      'active',
    );
  }));
test('完成后新增普通消息、附件失败及恢复都不重开或删除', () =>
  scenario(({ repo, d, run }) => {
    run();
    const id = repo.doc.tasks[0].id;
    repo.apply({ type: 'toggle', id, date: d.day }, repo.revision);
    for (const extra of [
      {},
      { incomplete: true },
      { needed: false },
      { needed: true, incomplete: true },
    ])
      run([{ ...d, ...extra }]);
    assert.equal(repo.doc.tasks.length, 1);
    assert.equal(repo.doc.tasks[0].id, id);
    assert.equal(repo.doc.tasks[0].completed, true);
  }));
test('有用文本与附件失败并存，附件恢复后移除未完成确认；再次需要复用原 ID', () =>
  scenario(({ repo, d, run }) => {
    run([{ ...d, useful: true, incomplete: true }]);
    const id = repo.doc.tasks[0].id;
    assert.equal(repo.doc.tasks[0].metadata.groupConfirmation.incomplete, true);
    run([{ ...d, useful: true, needed: false }]);
    assert.equal(repo.doc.tasks.length, 0);
    run([{ ...d, incomplete: true }]);
    assert.equal(repo.doc.tasks[0].id, id);
  }));
test('附件恢复但无有用信息时保留普通确认并清除标记', () =>
  scenario(({ repo, d, run }) => {
    run([{ ...d, incomplete: true }]);
    run();
    assert.equal(repo.doc.tasks.length, 1);
    assert.equal(repo.doc.tasks[0].metadata.groupConfirmation.incomplete, false);
    assert.doesNotMatch(repo.doc.tasks[0].description, /附件未完整分析/);
  }));
test('用户删除、手动编辑不会被后台覆盖或复活', () =>
  scenario(({ repo, d, run }) => {
    run();
    const id = repo.doc.tasks[0].id;
    repo.apply({ type: 'edit', id, task: { title: '我的人工备注' } }, repo.revision);
    run([{ ...d, incomplete: true }]);
    assert.equal(repo.doc.tasks[0].title, '我的人工备注');
    repo.apply({ type: 'delete', id }, repo.revision);
    run();
    assert.equal(repo.doc.tasks.length, 0);
  }));
test('跨日、平台、账号和群分别隔离；同名群不合并', () =>
  scenario(({ repo, d, run }) => {
    const all = [
      {},
      { day: '2026-10-23' },
      { platform: 'wechat' },
      { accountId: 'other' },
      { groupId: 'group:other' },
    ].map((x) => {
      const v = { ...d, ...x };
      v.key = keyFor(v);
      return v;
    });
    run(all);
    run(all);
    assert.equal(repo.doc.tasks.length, 5);
    assert.equal(new Set(repo.doc.tasks.map((t) => t.metadata.groupConfirmation.key)).size, 5);
  }));
test('已完成确认不阻止 QQ 实际重要任务进入原导入器', () =>
  scenario(({ repo, dir, d, run }) => {
    run();
    repo.apply({ type: 'toggle', id: repo.doc.tasks[0].id, date: d.day }, repo.revision);
    const result = createImporter(
      repo,
      dir,
    )([
      {
        key: 'f'.repeat(64),
        title: '提交课程报告',
        description: '真实任务依据',
        planDate: d.day,
        dueDate: null,
        priority: 'normal',
        sourceIds: ['9007199254740993'],
        groupId: d.groupId,
        platform: 'qq',
        sourceId: d.sourceId,
        accountId: d.accountId,
        existingTaskId: null,
      },
    ]);
    assert.equal(result.results[0].status, 'imported');
    assert.equal(repo.doc.tasks.length, 2);
    assert.equal(repo.doc.tasks[0].completed, true);
  }));
test('崩溃后从写前预留记录恢复同一 ID', () =>
  scenario(({ repo, dir, d, run }) => {
    const id = 'stable-reserved-id';
    atomicWrite(
      path.join(dir, 'state/group-confirmations.json'),
      JSON.stringify({ [d.key]: { ...d, id, state: 'creating' } }),
    );
    run();
    assert.equal(repo.doc.tasks[0].id, id);
    run();
    assert.equal(repo.doc.tasks.length, 1);
  }));
test('拒绝伪造唯一键，失败不写任务', () =>
  scenario(({ repo, d, run }) => {
    assert.throws(() => run([{ ...d, key: '0'.repeat(64) }]), /依据无效/);
    assert.equal(repo.doc.tasks.length, 0);
  }));
