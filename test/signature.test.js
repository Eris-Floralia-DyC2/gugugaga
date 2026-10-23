const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defaults, configValidate } = require('../src/core/config.cjs');
test('signature upgrade, empty text, multilingual text and invalid input', () => {
  const old = structuredClone(defaults);
  delete old.appearance.signature;
  assert.equal(configValidate(old).appearance.signature, null);
  for (const text of ['', '中文 English 😊 <img src=x onerror=alert(1)>', '长'.repeat(500)]) {
    const c = structuredClone(defaults);
    c.appearance.signature = text;
    assert.equal(configValidate(c).appearance.signature, text);
  }
  for (const text of [123, {}, '长'.repeat(501)]) {
    const c = structuredClone(defaults);
    c.appearance.signature = text;
    assert.throws(() => configValidate(c));
  }
});
