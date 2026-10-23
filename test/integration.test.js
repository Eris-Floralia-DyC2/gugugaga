const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskRepository } = require('../src/core/storage.cjs');
const { createImporter } = require('../src/core/task-api.cjs');
const { dueSchedule } = require('../src/core/integration.cjs');
test('任务导入幂等、账号隔离、手动编辑与用户删除保护', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-import-'));
  const repo = new TaskRepository(dir),
    importer = createImporter(repo, dir);
  try {
    const item = {
      key: 'a'.repeat(64),
      title: '测试课程任务',
      description: '来源依据',
      planDate: '2026-10-20',
      dueDate: null,
      priority: 'normal',
      sourceIds: ['message'],
      groupId: 'group@chatroom',
      existingTaskId: null,
      platform: 'wechat',
      sourceId: 'local',
      accountId: 'a',
    };
    const first = importer([item]).results[0];
    assert.equal(first.status, 'imported');
    importer([item]);
    assert.equal(repo.doc.tasks.length, 1);
    const wrong = { ...item, key: 'b'.repeat(64), accountId: 'b', existingTaskId: first.taskId };
    assert.equal(importer([wrong]).results[0].status, 'conflict');
    repo.apply({ type: 'edit', id: first.taskId, task: { title: '用户改过' } }, repo.revision);
    assert.equal(importer([{ ...item, title: '模型改写' }]).results[0].status, 'conflict');
    assert.equal(repo.doc.tasks[0].title, '用户改过');
    repo.apply({ type: 'delete', id: first.taskId }, repo.revision);
    assert.equal(importer([item]).results[0].status, 'previously-imported');
    assert.equal(repo.doc.tasks.length, 0);
    const feishu = {
      ...item,
      key: 'c'.repeat(64),
      platform: 'feishu',
      groupId: 'oc_abc',
      sourceId: 'feishu-user',
    };
    assert.equal(importer([feishu]).results[0].status, 'imported');
    assert.equal(repo.doc.tasks[0].metadata.messageSource.platform, 'feishu');
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('定时恢复：固定时间、休眠错过后补采、当天不重复', () => {
  assert.equal(dueSchedule(new Date(2026, 9, 20, 19, 59), '20:00', '2026-10-19'), null);
  assert.equal(dueSchedule(new Date(2026, 9, 20, 8, 0), '20:00', '2026-10-18'), '2026-10-19');
  assert.equal(dueSchedule(new Date(2026, 9, 20, 22, 0), '20:00', null), '2026-10-20');
  assert.equal(dueSchedule(new Date(2026, 9, 20, 22, 0), '20:00', '2026-10-20'), null);
  assert.equal(dueSchedule(new Date(2026, 9, 20, 22, 0), '20:00', '2026-10-21'), null);
});
