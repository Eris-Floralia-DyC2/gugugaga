const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWrite, backup } = require('./storage.cjs');
const { validate, validDate } = require('./tasks.cjs');
const keyFor = (d) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify([d.platform, d.accountId, d.groupId, d.day]))
    .digest('hex');
const baseline = (t) =>
  JSON.stringify([t.title, t.description, t.planDate, t.dueDate, t.priority, t.repeat]);

function reconcile(repo, dataRoot, decisions) {
  const file = path.join(dataRoot, 'state/group-confirmations.json');
  const ledger = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  repo.reload();
  if (repo.error) throw new Error(repo.error);
  const doc = structuredClone(repo.doc);
  let changed = false;
  const results = [];
  for (const d of decisions) {
    if (
      !['wechat', 'qq'].includes(d.platform) ||
      !validDate(d.day) ||
      d.key !== keyFor(d) ||
      !d.accountId ||
      !d.groupId ||
      typeof d.name !== 'string' ||
      !d.name ||
      d.name.length > 2000 ||
      typeof d.needed !== 'boolean' ||
      typeof d.incomplete !== 'boolean'
    )
      throw new Error('群确认依据无效');
    let entry = ledger[d.key];
    const matches = doc.tasks.filter((t) => t.metadata?.groupConfirmation?.key === d.key);
    if (matches.length > 1) throw new Error('同日群确认记录冲突，请检查任务备份');
    let task = matches[0];
    if (task && !entry)
      entry = ledger[d.key] = { ...d, id: task.id, state: 'active', baseline: baseline(task) };
    if (task?.completed || task?.completedAt) entry.state = 'completed';
    if (entry?.state === 'completed' || entry?.state === 'deleted') {
      results.push({ key: d.key, status: entry.state });
      continue;
    }
    if (entry?.state === 'active' && !task) {
      entry.state = 'deleted'; // User deletion is durable, just like normal imported tasks.
      continue;
    }
    if (!d.needed) {
      if (task && baseline(task) === entry.baseline) {
        entry.snapshot = task;
        entry.state = 'resolved';
        doc.tasks = doc.tasks.filter((t) => t.id !== task.id);
        changed = true;
      }
      continue;
    }
    if (!entry) entry = ledger[d.key] = { ...d, id: crypto.randomUUID(), state: 'creating' };
    if (!task) {
      const now = new Date().toISOString();
      task = entry.snapshot || {
        id: entry.id,
        createdAt: now,
        completed: false,
        completedAt: null,
        dueDate: null,
        repeat: 'none',
        occurrences: {},
        priority: 'normal',
        order: Math.max(-1, ...doc.tasks.map((t) => t.order)) + 1,
        metadata: {},
      };
      doc.tasks.push(task);
      changed = true;
    }
    // Keep user edits. Attachment flags remain visible without changing completion state.
    const editable = !entry.baseline || baseline(task) === entry.baseline;
    if (editable) {
      task.title = `确认${d.name}群的消息`.slice(0, 500);
      task.description = `${d.day} · ${d.platform === 'qq' ? 'QQ' : '微信'} · ${d.name}\n${d.incomplete ? '附件未完整分析：请人工核对图片、语音或文件。' : '当天消息已成功分析，累计没有提取到有用信息，请人工确认。'}`;
      task.planDate = d.day;
      entry.baseline = baseline(task);
    }
    task.metadata.groupConfirmation = {
      key: d.key,
      platform: d.platform,
      accountId: d.accountId,
      groupId: d.groupId,
      sourceId: d.sourceId,
      day: d.day,
      incomplete: d.incomplete,
    };
    // Write-ahead reservation: retries recover the SAME id after a crash.
    Object.assign(entry, d, { snapshot: task });
    entry.state = 'creating';
    changed = true;
    results.push({ key: d.key, status: 'active', taskId: task.id });
  }
  validate(doc);
  atomicWrite(file, JSON.stringify(ledger));
  if (changed) {
    backup(repo.file, repo.backups);
    atomicWrite(repo.file, JSON.stringify(doc, null, 2) + '\n');
    repo.reload();
  }
  for (const e of Object.values(ledger)) if (e.state === 'creating') e.state = 'active';
  atomicWrite(file, JSON.stringify(ledger));
  return results;
}
module.exports = { reconcile, keyFor };
