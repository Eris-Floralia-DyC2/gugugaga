const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
module.exports = async (c) => {
  const receipt = path.join(c.dataRoot, 'state', 'acceptance-receipt.json');
  const phase = process.env.WS_LIFECYCLE_PHASE || 'verify';
  const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const results = [];
  try {
    if (phase === 'seed') {
      const next = c.repo.apply(
        {
          type: 'add',
          task: {
            title: '便携移动与更新验证 · 保留这条隔离数据',
            description: '只存在于隔离测试目录。',
            priority: 'high',
          },
        },
        c.repo.revision,
      );
      const task = next.document.tasks.at(-1);
      c.repo.apply({ type: 'toggle', id: task.id }, c.repo.revision);
      fs.appendFileSync(
        path.join(c.themes.dir, 'default', 'style.css'),
        '\n/* portable-roundtrip-marker */\n',
      );
      c.credentials.set('portable-lifecycle-fixture-not-a-real-key');
      const config = structuredClone(c.config.value);
      config.mode = 'desktop';
      c.config.save(config);
      const record = {
        id: task.id,
        title: task.title,
        taskHash: hash(c.repo.file),
        themeHash: hash(path.join(c.themes.dir, 'default', 'style.css')),
        key: 'portable-lifecycle-fixture-not-a-real-key',
        bounds: c.bounds(),
      };
      fs.writeFileSync(receipt, JSON.stringify(record, null, 2));
      results.push('seed persisted');
    } else {
      const record = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      assert.equal(hash(c.repo.file), record.taskHash);
      assert.equal(hash(path.join(c.themes.dir, 'default', 'style.css')), record.themeHash);
      const t = c.repo.doc.tasks.find((t) => t.id === record.id);
      assert.equal(t.title, record.title);
      assert.equal(t.completed, true);
      assert.equal(c.credentials.get(), record.key);
      assert.deepEqual(c.bounds(), record.bounds);
      results.push('tasks/theme/credentials/bounds persisted');
    }
    fs.writeFileSync(
      path.join(c.dataRoot, 'state', `lifecycle-${phase}.json`),
      JSON.stringify(
        {
          ok: true,
          phase,
          results,
          packaged: c.app.isPackaged,
          executable: process.execPath,
          dataRoot: c.dataRoot,
        },
        null,
        2,
      ),
    );
    c.quit();
  } catch (e) {
    fs.writeFileSync(
      path.join(c.dataRoot, 'state', `lifecycle-${phase}.json`),
      JSON.stringify({ ok: false, error: e.stack }, null, 2),
    );
    c.quit();
    c.app.exit(1);
  }
};
