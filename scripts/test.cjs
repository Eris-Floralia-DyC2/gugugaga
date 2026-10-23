const path = require('node:path'),
  fs = require('node:fs'),
  { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const p = require('../src/core/private-root.cjs');
p.initialize(p.resolvePrivateRoot(root));
const files = fs
  .readdirSync(path.join(root, 'test'))
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => path.join(root, 'test', f));
const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
