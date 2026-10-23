const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Integration } = require('../src/core/integration.cjs');
test('清空结果只移除展示消息，保留任务、历史与分析进度，重启不恢复旧展示', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-result-'));
  fs.mkdirSync(path.join(root, 'state'));
  fs.writeFileSync(path.join(root, 'tasks.json'), 'original-task');
  fs.writeFileSync(path.join(root, 'history.json'), 'original-history');
  const integration = Object.create(Integration.prototype);
  Object.assign(integration, {
    dataRoot: root,
    running: false,
    lastTaskResult: {
      read: 7,
      imported: 2,
      batches: 1,
      review: ['需确认'],
      usefulInformation: [{ text: '课程安排' }],
    },
    lastResult: { id: 'summary' },
  });
  await integration.action('clear_result_messages');
  const persisted = JSON.parse(fs.readFileSync(path.join(root, 'state/last-task-result.json')));
  assert.deepEqual(persisted.review, []);
  assert.deepEqual(persisted.usefulInformation, []);
  assert.equal(persisted.imported, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state/last-summary.json'))), null);
  assert.equal(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8'), 'original-task');
  assert.equal(fs.readFileSync(path.join(root, 'history.json'), 'utf8'), 'original-history');
  integration.running = true;
  await assert.rejects(integration.action('clear_result_messages'), /结束/);
});
