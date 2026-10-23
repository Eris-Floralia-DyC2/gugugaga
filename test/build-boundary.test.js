const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('packaging rejects unknown runtime input, private files and linked directories before staging', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-build-boundary-'));
  const project = path.join(base, 'project');
  const privateRoot = path.join(base, 'private');
  try {
    for (const dir of [
      'src/core',
      'assets',
      'defaults',
      'test',
      'docs',
      'runtime/ws-worker',
      'licenses',
      'scripts',
    ])
      fs.mkdirSync(path.join(project, dir), { recursive: true });
    for (const rel of [
      'scripts/build.cjs',
      'src/core/private-root.cjs',
      'src/core/storage.cjs',
      'src/core/tasks.cjs',
    ])
      fs.copyFileSync(path.join(__dirname, '..', rel), path.join(project, rel));
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ version: '0.0.0' }));
    fs.writeFileSync(
      path.join(project, 'runtime/ws-worker/ws-worker.exe'),
      'synthetic-not-executable',
    );
    const run = (selectedRoot = privateRoot) =>
      spawnSync(process.execPath, [path.join(project, 'scripts/build.cjs')], {
        env: {
          ...process.env,
          WS_PRIVATE_ROOT: selectedRoot,
          NODE_PATH: path.join(__dirname, '..', 'node_modules'),
        },
        encoding: 'utf8',
        timeout: 10000,
      });
    const overlapping = run(path.join(project, 'src/private'));
    assert.equal(overlapping.status, 1);
    assert.match(overlapping.stderr, /PrivateRoot/);
    const unknown = path.join(project, 'runtime/unreviewed.txt');
    fs.writeFileSync(unknown, 'synthetic');
    let result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /未审核/);
    fs.unlinkSync(unknown);
    const secret = path.join(project, 'runtime/ws-worker/credential.dpapi');
    fs.writeFileSync(secret, 'synthetic');
    result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /私密/);
    fs.unlinkSync(secret);
    const link = path.join(project, 'runtime/ws-worker/linked');
    fs.symlinkSync(path.join(project, 'assets'), link, 'junction');
    result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /链接/);
    fs.unlinkSync(link);
    assert.equal(fs.existsSync(path.join(privateRoot, 'build')), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
