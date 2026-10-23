const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWrite } = require('./storage.cjs');

// One rule for Electron, worker and MCP: explicit absolute WS_PRIVATE_ROOT,
// otherwise WS-Private beside the executable (project root in development).
function resolvePrivateRoot(programRoot, env = process.env) {
  const value = env.WS_PRIVATE_ROOT;
  if (value && !path.isAbsolute(value)) throw new Error('WS_PRIVATE_ROOT 必须为绝对目录');
  const defaultRoot = path.join(programRoot, 'WS-Private');
  const pending = defaultRoot + '.pending';
  const root = value || (fs.existsSync(pending) ? fs.realpathSync(pending) : defaultRoot);
  fs.mkdirSync(root, { recursive: true });
  return fs.realpathSync(root);
}
function initialize(root) {
  for (const dir of [
    'config',
    'tasks',
    'themes',
    'backgrounds',
    'state',
    'backups',
    'cache',
    'logs',
    'temp',
    'exports',
    'transactions',
  ])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  const marker = path.join(root, 'private-root.json');
  if (fs.existsSync(marker)) {
    const m = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (m.version !== 1) throw new Error('PrivateRoot 版本较新，请使用兼容程序');
  } else atomicWrite(marker, JSON.stringify({ version: 1, id: crypto.randomUUID() }));
  // Set before Chromium or Python initialize their temporary-file services.
  process.env.WS_PRIVATE_ROOT = root;
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = path.join(root, 'temp');
  return root;
}
function walk(root, relative = '') {
  const files = [];
  for (const e of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const rel = path.join(relative, e.name),
      full = path.join(root, rel);
    if (fs.lstatSync(full).isSymbolicLink())
      throw new Error('私密目录中存在链接，请先核对后再迁移');
    if (e.isDirectory()) files.push(...walk(root, rel));
    else if (e.isFile()) files.push(rel);
  }
  return files;
}
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function copyVerified(source, target) {
  if (fs.existsSync(target)) throw new Error('目标已存在；请选择空目录');
  fs.mkdirSync(target, { recursive: true });
  try {
    for (const rel of walk(source)) {
      const dst = path.join(target, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(source, rel), dst, fs.constants.COPYFILE_EXCL);
      if (sha(dst) !== sha(path.join(source, rel))) throw new Error('迁移校验失败；原目录完整保留');
    }
  } catch (e) {
    throw new Error('迁移未完成，原数据保留。请检查目标空间及权限；不完整副本需核对后处理。');
  }
}
module.exports = { resolvePrivateRoot, initialize, walk, sha, copyVerified };
