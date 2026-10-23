const test = require('node:test');
const assert = require('node:assert/strict');
const { Integration } = require('../src/core/integration.cjs');
test('renderer cannot replace allowlisted worker command or supply non-object payload', async () => {
  const integration = Object.create(Integration.prototype);
  let calls = 0;
  integration.worker = async (request) => {
    calls++;
    return request;
  };
  integration.operation = async (_label, fn) => fn();
  for (const payload of [{ command: 'prepare' }, null, [], 'bad']) {
    await assert.rejects(integration.action('save_summary_selection', payload), /参数无效/);
  }
  assert.equal(calls, 0);
  const result = await integration.action('save_summary_selection', { selection: { version: 1 } });
  assert.equal(result.command, 'save_summary_selection');
  assert.equal(calls, 1);
});
