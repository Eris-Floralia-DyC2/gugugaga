const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { validate, mutate } = require('./tasks.cjs');
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== null && fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function backup(file, dir) {
  if (!fs.existsSync(file)) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(
    file,
    path.join(dir, `${path.basename(file)}.${Date.now()}-${crypto.randomUUID().slice(0, 8)}.bak`),
  );
  const files = fs
    .readdirSync(dir)
    .filter((x) => x.startsWith(path.basename(file) + '.'))
    .sort()
    .reverse();
  for (const f of files.slice(40)) fs.unlinkSync(path.join(dir, f));
}
class TaskRepository extends EventEmitter {
  constructor(root) {
    super();
    this.file = path.join(root, 'tasks', 'tasks.json');
    this.backups = path.join(root, 'backups');
    this.doc = { version: 1, tasks: [] };
    this.revision = null;
    this.error = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) atomicWrite(this.file, JSON.stringify(this.doc, null, 2));
    this.reload();
    this.watcher = fs.watch(path.dirname(this.file), () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.reload(), 180);
    });
  }
  reload() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
      if (Buffer.byteLength(raw) > 20 * 1024 * 1024)
        throw new Error('任务文件大于 20MB，停止自动加载');
      const doc = validate(JSON.parse(raw));
      const rev = hash(raw);
      if (rev !== this.revision || this.error) {
        this.doc = doc;
        this.revision = rev;
        this.error = null;
        this.emit('change');
      }
    } catch (e) {
      this.error = `任务文件未载入，保留最近有效数据。${e.message}`;
      this.emit('change');
    }
  }
  snapshot() {
    return { document: structuredClone(this.doc), revision: this.revision, error: this.error };
  }
  apply(action, expected) {
    // Re-read immediately before every mutation; stale GUI revisions cannot overwrite an external edit.
    this.reload();
    if (this.error) throw new Error(this.error);
    if (expected !== this.revision)
      throw new Error('任务文件已发生变化，本次操作未写入。请检查刷新后的内容并重试。');
    const next = mutate(this.doc, action);
    const raw = JSON.stringify(next, null, 2) + '\n';
    backup(this.file, this.backups);
    atomicWrite(this.file, raw);
    this.doc = next;
    this.revision = hash(raw);
    this.emit('change');
    return this.snapshot();
  }
  restore(filename) {
    if (!/^tasks\.json\.[\w-]+\.bak$/.test(filename)) throw new Error('备份名称无效');
    const raw = fs.readFileSync(path.join(this.backups, filename), 'utf8');
    validate(JSON.parse(raw));
    backup(this.file, this.backups);
    atomicWrite(this.file, raw);
    this.reload();
  }
  close() {
    clearTimeout(this.timer);
    this.watcher.close();
  }
}
module.exports = { atomicWrite, backup, TaskRepository, hash };
