const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWrite } = require('./storage.cjs');
const { walk, sha } = require('./private-root.cjs');
const { validate } = require('./tasks.cjs');
const { configValidate } = require('./config.cjs');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const groups = {
  tasks: [
    'tasks',
    'state/task-import-journal.json',
    'state/source-bindings.json',
    'state/group-confirmations.json',
  ],
  settings: [
    'config/settings.json',
    'config/integration.json',
    'config/summary.json',
    'config/conversation-directory.json',
    'config/rules',
    'themes',
    'backgrounds',
    'state/window.json',
    'state/source-bindings.json',
    'state/qq-accounts.json',
    'state/summary-window.json',
  ],
  history: [
    'databases',
    'cache/attachments',
    'summaries',
    'state/last-summary.json',
    'state/last-task-result.json',
  ],
};
function allowed(rel) {
  return (
    (rel === 'state/import-origin.json' ||
      Object.values(groups)
        .flat()
        .some((p) => rel === p || rel.startsWith(p + '/'))) &&
    !/(^|\/)(credential|task-api|profile|session|secrets)(\.|\/|$)/i.test(rel)
  );
}
function recover(root) {
  const dir = path.join(root, 'transactions');
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir)) {
    const journal = path.join(dir, e, 'journal.json');
    if (!fs.existsSync(journal)) continue;
    const j = read(journal);
    if (j.version !== 1) throw new Error('迁移事务版本无效');
    if (j.status !== 'committing') continue;
    for (const item of [...j.files].reverse()) {
      if (!allowed(item.path) || item.path.includes('..') || item.path.includes('\\'))
        throw new Error('迁移事务路径无效');
      const target = path.join(root, item.path),
        old = path.join(dir, e, 'before', item.path);
      if (item.existed) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(old, target);
      } else if (fs.existsSync(target)) fs.unlinkSync(target);
    }
    j.status = 'rolled-back';
    atomicWrite(journal, JSON.stringify(j));
  }
}
function exportPrivate(root, selection) {
  if (!Array.isArray(selection) || !selection.length || selection.some((k) => !groups[k]))
    throw new Error('请选择任务、设置或历史');
  const destination = path.join(root, 'exports', 'WS-PRIVATE-MIGRATION-' + crypto.randomUUID());
  const content = path.join(destination, 'content');
  fs.mkdirSync(content, { recursive: true });
  if (selection.includes('tasks')) {
    const ledgerFile = path.join(root, 'state/source-bindings.json');
    const ledger = fs.existsSync(ledgerFile) ? read(ledgerFile) : {};
    const tasksFile = path.join(root, 'tasks/tasks.json');
    for (const t of fs.existsSync(tasksFile) ? read(tasksFile).tasks : []) {
      const m = t.metadata?.messageSource;
      if (m?.sourceId && m.accountId) ledger[m.sourceId] = [m.platform || 'wechat', m.accountId];
    }
    atomicWrite(ledgerFile, JSON.stringify(ledger));
  }
  const files = [];
  const selectedFiles = new Set();
  for (const key of selection)
    for (const prefix of groups[key]) {
      const full = path.join(root, prefix);
      if (!fs.existsSync(full)) continue;
      if (fs.lstatSync(full).isSymbolicLink()) throw new Error('迁移内容中存在链接，请先核对');
      if (fs.statSync(full).isDirectory())
        for (const rel of walk(full)) selectedFiles.add(path.join(prefix, rel));
      else selectedFiles.add(prefix);
    }
  for (const rel of selectedFiles) {
    const name = rel.split(path.sep).join('/');
    if (
      !selection.some((k) => groups[k].some((p) => name === p || name.startsWith(p + '/'))) ||
      !allowed(name)
    )
      continue;
    if (/-(wal|shm)$/.test(name)) throw new Error('消息库仍有写入，请退出采集后重试');
    const dest = path.join(content, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, rel), dest);
    if (name === 'config/integration.json') {
      const c = read(dest);
      c.enabled = false;
      for (const s of c.sources) {
        s.db_dir = '';
        s.enabled = false;
        delete s.remote;
        delete s.groups;
        delete s.range;
        delete s.schedule;
        s.account_name ||= s.platform === 'wechat' ? '微信账号' : '飞书账号';
      }
      delete c.remote_scope;
      delete c.asr_enabled;
      delete c.remote_asr;
      c.version = 3;
      c.schedule_action ||= 'tasks';
      atomicWrite(dest, JSON.stringify(c));
    }
    if (name === 'config/settings.json') {
      const c = read(dest);
      c.autostart = false;
      atomicWrite(dest, JSON.stringify(c));
    }
    files.push({ path: name, sha256: sha(dest), bytes: fs.statSync(dest).size });
  }
  // The origin is private metadata for rebasing WS-owned references on import.
  atomicWrite(
    path.join(destination, 'manifest.json'),
    JSON.stringify(
      {
        format: 'WS-PRIVATE-MIGRATION',
        version: 1,
        credentials: false,
        selection,
        origin: root,
        files,
      },
      null,
      2,
    ),
  );
  return { directory: destination, files: files.length, credentials: false };
}
function importPrivate(root, source, { failAfter = -1 } = {}) {
  const m = read(path.join(source, 'manifest.json'));
  if (
    m.format !== 'WS-PRIVATE-MIGRATION' ||
    m.version !== 1 ||
    m.credentials !== false ||
    !Array.isArray(m.files) ||
    m.files.length > 50000
  )
    throw new Error('私密迁移包格式或版本不支持');
  const seen = new Set();
  for (const f of m.files) {
    if (
      typeof f.path !== 'string' ||
      f.path.includes('..') ||
      f.path.includes('\\') ||
      path.isAbsolute(f.path) ||
      !allowed(f.path) ||
      seen.has(f.path)
    )
      throw new Error('迁移包包含不允许的路径');
    seen.add(f.path);
    const full = path.join(source, 'content', f.path);
    const real = fs.realpathSync(full),
      base = fs.realpathSync(path.join(source, 'content')) + path.sep;
    if (
      !real.startsWith(base) ||
      fs.lstatSync(full).isSymbolicLink() ||
      sha(full) !== f.sha256 ||
      fs.statSync(full).size !== f.bytes
    )
      throw new Error('迁移包完整性校验失败');
    if (f.path === 'tasks/tasks.json') validate(read(full));
    if (f.path === 'config/settings.json') configValidate(read(full));
  }
  const current = path.join(root, 'tasks/tasks.json');
  if (seen.has('tasks/tasks.json') && fs.existsSync(current) && read(current).tasks.length)
    throw new Error('目标已有任务。为防止覆盖，请选择新的空 PrivateRoot 再导入');
  const tx = path.join(root, 'transactions', crypto.randomUUID());
  fs.mkdirSync(tx, { recursive: true });
  const journal = { version: 1, status: 'preparing', files: [] };
  for (const f of m.files) {
    const target = path.join(root, f.path),
      old = path.join(tx, 'before', f.path),
      staged = path.join(tx, 'after', f.path);
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.copyFileSync(path.join(source, 'content', f.path), staged);
    const existed = fs.existsSync(target);
    if (existed) {
      fs.mkdirSync(path.dirname(old), { recursive: true });
      fs.copyFileSync(target, old);
    }
    journal.files.push({ path: f.path, existed });
  }
  // Index references are rebased by the worker before any message is read.
  const relocation = path.join(root, 'state/import-origin.json');
  const relocationStage = path.join(tx, 'after/state/import-origin.json');
  fs.mkdirSync(path.dirname(relocationStage), { recursive: true });
  atomicWrite(relocationStage, JSON.stringify({ version: 1, origin: m.origin }));
  const existed = fs.existsSync(relocation);
  if (existed) {
    const previous = path.join(tx, 'before/state/import-origin.json');
    fs.mkdirSync(path.dirname(previous), { recursive: true });
    fs.copyFileSync(relocation, previous);
  }
  journal.files.push({ path: 'state/import-origin.json', existed });
  try {
    journal.status = 'committing';
    atomicWrite(path.join(tx, 'journal.json'), JSON.stringify(journal));
    let n = 0;
    for (const f of journal.files) {
      if (n++ === failAfter) throw new Error('Injected migration failure');
      const target = path.join(root, f.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(tx, 'after', f.path), target);
    }
    journal.status = 'committed';
    atomicWrite(path.join(tx, 'journal.json'), JSON.stringify(journal));
    return { imported: m.files.length, credentials: 'requires_reconnect', backup: tx };
  } catch (e) {
    recover(root);
    throw e;
  }
}
module.exports = { exportPrivate, importPrivate, recover };
