const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { resolvePrivateRoot, initialize } = require('../src/core/private-root.cjs');
const { exportPrivate, importPrivate, recover } = require('../src/core/private-transfer.cjs');
const { TaskRepository } = require('../src/core/storage.cjs');
const { Config } = require('../src/core/config.cjs');
const { spawnSync } = require('node:child_process');
function root() {
  return initialize(fs.mkdtempSync(path.join(process.env.WS_PRIVATE_ROOT || os.tmpdir(), 'case-')));
}
test('PrivateRoot ignores cwd and rejects relative overrides', () => {
  const a = root();
  assert.equal(resolvePrivateRoot(a, {}), fs.realpathSync(path.join(a, 'WS-Private')));
  assert.throws(() => resolvePrivateRoot(a, { WS_PRIVATE_ROOT: 'relative' }));
});
test('Private transfer retains task edits/completion and dedupe, omits credentials/profile and rolls back injected failure', () => {
  const a = root(),
    b = root();
  const repo = new TaskRepository(a),
    cfg = new Config(a);
  const personal = structuredClone(cfg.value);
  personal.appearance.signature = '迁移保留 signature 😊';
  cfg.save(personal);
  repo.apply({ type: 'add', task: { title: 'synthetic migration fixture' } }, repo.revision);
  const task = repo.doc.tasks[0];
  repo.apply({ type: 'toggle', id: task.id }, repo.revision);
  repo.close();
  cfg.close();
  fs.writeFileSync(path.join(a, 'config/credential.dpapi'), 'synthetic-protected');
  fs.writeFileSync(
    path.join(a, 'state/task-import-journal.json'),
    JSON.stringify({ fixture: task.id }),
  );
  const ex = exportPrivate(a, ['tasks', 'settings']);
  const manifest = JSON.parse(fs.readFileSync(path.join(ex.directory, 'manifest.json')));
  assert.ok(
    !manifest.files.some((f) => f.path.includes('credential') || f.path.includes('profile')),
  );
  assert.throws(() => importPrivate(b, ex.directory, { failAfter: 1 }));
  recover(b);
  assert.equal(fs.existsSync(path.join(b, 'tasks/tasks.json')), false);
  importPrivate(b, ex.directory);
  const result = JSON.parse(fs.readFileSync(path.join(b, 'tasks/tasks.json'))).tasks[0];
  assert.equal(result.completed, true);
  assert.equal(result.title, task.title);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(b, 'config/settings.json'))).appearance.signature,
    personal.appearance.signature,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(b, 'state/task-import-journal.json'))).fixture,
    task.id,
  );
  assert.throws(() => importPrivate(b, ex.directory), /已有任务/);
});
test('Private transfer rejects tampering, traversal and future versions before mutation', () => {
  const a = root(),
    b = root();
  const repo = new TaskRepository(a);
  repo.close();
  const ex = exportPrivate(a, ['tasks']),
    mf = path.join(ex.directory, 'manifest.json'),
    m = JSON.parse(fs.readFileSync(mf));
  const original = JSON.stringify(m);
  m.version = 99;
  fs.writeFileSync(mf, JSON.stringify(m));
  assert.throws(() => importPrivate(b, ex.directory));
  fs.writeFileSync(mf, original);
  fs.appendFileSync(path.join(ex.directory, 'content/tasks/tasks.json'), 'x');
  assert.throws(() => importPrivate(b, ex.directory), /完整性/);
  m.version = 1;
  m.files[0].path = '../escape';
  fs.writeFileSync(mf, JSON.stringify(m));
  assert.throws(() => importPrivate(b, ex.directory), /路径/);
  assert.equal(fs.existsSync(path.join(b, 'tasks/tasks.json')), false);
});
test('Full PrivateRoot relocation preserves profile files and keeps the original backup inside the selected root', () => {
  const base = root(),
    program = path.join(base, 'program');
  fs.mkdirSync(program);
  const original = initialize(path.join(program, 'WS-Private'));
  fs.mkdirSync(path.join(original, 'cache/profile'), { recursive: true });
  fs.writeFileSync(path.join(original, 'cache/profile/Local State'), 'synthetic-profile-marker');
  const target = path.join(base, '新位置 空格', 'WS-Private');
  const receipt = path.join(base, 'receipt.cjs');
  fs.writeFileSync(receipt, '');
  const job = path.join(base, 'job.json');
  fs.writeFileSync(
    job,
    JSON.stringify({
      pid: 2147483646,
      source: original,
      target,
      link: path.join(program, 'WS-Private'),
      empty: false,
      executable: process.execPath,
      args: [receipt],
    }),
  );
  const run = spawnSync(
    process.execPath,
    [path.resolve(__dirname, '../src/core/relocate.cjs'), job],
    { env: { ...process.env }, windowsHide: true },
  );
  assert.equal(run.status, 0, run.stderr.toString());
  assert.equal(fs.realpathSync(path.join(program, 'WS-Private')), fs.realpathSync(target));
  const record = JSON.parse(fs.readFileSync(path.join(target, 'logs/relocation.json')));
  assert.equal(record.ok, true);
  assert.ok(record.retained.startsWith(target + path.sep));
  assert.equal(
    fs.readFileSync(path.join(target, 'cache/profile/Local State'), 'utf8'),
    'synthetic-profile-marker',
  );
  assert.equal(
    fs.readFileSync(path.join(record.retained, 'cache/profile/Local State'), 'utf8'),
    'synthetic-profile-marker',
  );
  // Keep fixture contents as evidence, but remove the agent-created junction so
  // future full PrivateRoot moves are not obstructed by test-only links.
  process.env.WS_PRIVATE_ROOT = base;
  fs.unlinkSync(path.join(program, 'WS-Private'));
});

