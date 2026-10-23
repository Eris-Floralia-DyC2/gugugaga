// Loopback-only import API. All task changes run synchronously on WS's main thread.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { validate, validDate } = require('./tasks.cjs');
const { atomicWrite, backup } = require('./storage.cjs');
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields = (t) => ({
  title: t.title,
  description: t.description,
  planDate: t.planDate,
  dueDate: t.dueDate,
  priority: t.priority,
});
function check(item) {
  if (
    !item ||
    typeof item !== 'object' ||
    !/^[a-f0-9]{64}$/.test(item.key || '') ||
    typeof item.title !== 'string' ||
    !item.title.trim() ||
    item.title.length > 500 ||
    typeof item.description !== 'string' ||
    item.description.length > 18000 ||
    !validDate(item.planDate) ||
    (item.dueDate !== null && !validDate(item.dueDate)) ||
    !['low', 'normal', 'high'].includes(item.priority) ||
    !Array.isArray(item.sourceIds) ||
    !item.sourceIds.length ||
    item.sourceIds.length > 30 ||
    item.sourceIds.some((s) => typeof s !== 'string' || s.length > 400) ||
    typeof item.groupId !== 'string' ||
    !item.groupId ||
    item.groupId.length > 200 ||
    (item.platform !== undefined && !['wechat', 'feishu', 'qq'].includes(item.platform)) ||
    (item.sourceId !== undefined && !/^[a-zA-Z0-9_-]{1,80}$/.test(item.sourceId)) ||
    (item.accountId !== undefined &&
      (typeof item.accountId !== 'string' || item.accountId.length > 200)) ||
    (item.confidence !== undefined &&
      (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1)) ||
    (item.existingTaskId !== null &&
      (typeof item.existingTaskId !== 'string' || item.existingTaskId.length > 100))
  )
    throw new Error('导入任务格式无效');
  return item;
}
function createImporter(repo, dataRoot) {
  const journalFile = path.join(dataRoot, 'state', 'task-import-journal.json');
  let journal = fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile, 'utf8')) : {};
  return function importTasks(items) {
    journal = fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile, 'utf8')) : {};
    if (!Array.isArray(items) || !items.length || items.length > 200)
      throw new Error('每批允许 1–200 条任务');
    items.forEach(check);
    if (new Set(items.map((i) => i.key)).size !== items.length) throw new Error('同一批任务重复');
    repo.reload();
    if (repo.error) throw new Error(repo.error);
    const doc = structuredClone(repo.doc),
      nextJournal = structuredClone(journal);
    const results = [];
    let changed = false;
    for (const item of items) {
      const platform = item.platform || 'wechat',
        sourceId = item.sourceId || 'wechat-local',
        accountId = item.accountId || '';
      const metadata = (t) => t.metadata?.messageSource || t.metadata?.wechat;
      const matches = (m) =>
        m &&
        m.groupId === item.groupId &&
        (m.sourceId || 'wechat-local') === sourceId &&
        (m.accountId || '') === accountId;
      let existing = doc.tasks.find(
        (t) => matches(metadata(t)) && metadata(t).keys?.includes(item.key),
      );
      if (!existing && !item.existingTaskId) {
        const norm = (s) => s.replace(/\s+/g, '').toLowerCase();
        const same = doc.tasks.filter(
          (t) => matches(metadata(t)) && norm(t.title) === norm(item.title),
        );
        if (same.length === 1) existing = same[0];
        else if (same.length > 1) {
          results.push({
            key: item.key,
            status: 'conflict',
            reason: '存在多个同名来源任务，需人工核对',
          });
          continue;
        }
        if (
          !existing &&
          doc.tasks.some(
            (t) => !metadata(t) && norm(t.title) === norm(item.title) && t.dueDate === item.dueDate,
          )
        ) {
          results.push({
            key: item.key,
            status: 'conflict',
            reason: '存在同名手动任务，保留原任务并避免重复新增',
          });
          continue;
        }
      }
      if (!existing && nextJournal[item.key]) {
        results.push({ key: item.key, status: 'previously-imported' });
        continue; // Deleted by the user, or already processed. Do not resurrect.
      }
      if (!existing && item.existingTaskId) {
        existing = doc.tasks.find((t) => t.id === item.existingTaskId);
        if (!existing || !matches(metadata(existing))) {
          results.push({ key: item.key, status: 'conflict', reason: '原任务已删除或来源不匹配' });
          continue;
        }
      }
      if (existing) {
        const meta = metadata(existing);
        if (
          matches(meta) &&
          meta.keys?.includes(item.key) &&
          digest(fields(existing)) === digest(fields(item))
        ) {
          results.push({ key: item.key, status: 'unchanged', taskId: existing.id });
          continue;
        }
        if (
          !matches(meta) ||
          digest(fields(existing)) !== meta.baseline ||
          existing.completed ||
          existing.repeat !== 'none'
        ) {
          results.push({
            key: item.key,
            status: 'conflict',
            reason: '任务已完成或被手动修改，保留原状',
          });
          continue;
        }
        Object.assign(existing, fields(item));
        meta.keys = [...new Set([...(meta.keys || []), item.key])];
        meta.sourceIds = [...new Set([...(meta.sourceIds || []), ...item.sourceIds])].slice(-100);
        meta.baseline = digest(fields(existing));
        meta.updatedAt = new Date().toISOString();
      } else {
        existing = {
          id: crypto.randomUUID(),
          ...fields(item),
          createdAt: new Date().toISOString(),
          completed: false,
          completedAt: null,
          priority: item.priority,
          repeat: 'none',
          occurrences: {},
          order: Math.max(-1, ...doc.tasks.map((t) => t.order)) + 1,
          metadata: {
            messageSource: {
              platform,
              sourceId,
              accountId,
              confidence: item.confidence ?? null,
              groupId: item.groupId,
              keys: [item.key],
              sourceIds: item.sourceIds,
              baseline: digest(fields(item)),
              updatedAt: new Date().toISOString(),
            },
          },
        };
        doc.tasks.push(existing);
      }
      nextJournal[item.key] = existing.id;
      results.push({ key: item.key, status: 'imported', taskId: existing.id });
      changed = true;
    }
    validate(doc);
    if (changed) {
      backup(repo.file, repo.backups);
      atomicWrite(repo.file, JSON.stringify(doc, null, 2) + '\n');
      // If the process stops here, task metadata provides idempotence on retry.
      atomicWrite(journalFile, JSON.stringify(nextJournal));
      journal = nextJournal;
      repo.reload();
    }
    return { results };
  };
}
function startTaskApi({ repo, dataRoot, log = () => {} }) {
  const token = crypto.randomBytes(32).toString('hex');
  const importer = createImporter(repo, dataRoot);
  const discovery = path.join(dataRoot, 'config', 'task-api.json');
  const server = http.createServer((req, res) => {
    const send = (code, value) => {
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(JSON.stringify(value));
    };
    const origin = req.headers.origin;
    if (origin || req.headers.host !== `127.0.0.1:${server.address().port}`)
      return send(403, { error: 'Forbidden' });
    const auth = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from('Bearer ' + token);
    if (auth.length !== expected.length || !crypto.timingSafeEqual(auth, expected))
      return send(401, { error: 'Unauthorized' });
    if (req.method === 'GET' && req.url === '/v1/tasks') {
      repo.reload();
      if (repo.error) return send(409, { error: '任务文件需要修复' });
      return send(200, {
        tasks: repo.doc.tasks
          .filter((t) => t.metadata?.wechat || t.metadata?.messageSource)
          .map((t) => ({
            id: t.id,
            title: t.title,
            description: t.description,
            planDate: t.planDate,
            dueDate: t.dueDate,
            completed: t.completed,
            groupId: (t.metadata.messageSource || t.metadata.wechat).groupId,
            sourceId: (t.metadata.messageSource || t.metadata.wechat).sourceId || 'wechat-local',
          })),
      });
    }
    if (req.method !== 'POST' || req.url !== '/v1/import') return send(404, { error: 'Not found' });
    if (!String(req.headers['content-type']).startsWith('application/json'))
      return send(415, { error: 'JSON required' });
    const chunks = [];
    let size = 0,
      rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        rejected = true;
        send(413, { error: 'Too large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        send(200, importer(JSON.parse(Buffer.concat(chunks)).tasks));
      } catch {
        send(409, { error: '任务导入未完成：格式、状态或文件存在冲突' });
      }
    });
    req.on('error', () => {});
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on('error', () => log('task_api_failed'));
  server.listen(0, '127.0.0.1', () => {
    atomicWrite(
      discovery,
      JSON.stringify({ version: 1, port: server.address().port, token, pid: process.pid }),
    );
    log('task_api_ready');
  });
  return () => {
    server.close();
    try {
      if (JSON.parse(fs.readFileSync(discovery, 'utf8')).pid === process.pid)
        fs.unlinkSync(discovery);
    } catch {}
  };
}
module.exports = { startTaskApi, createImporter };
