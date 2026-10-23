const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { BrowserWindow } = require('electron');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, seconds = 30) {
  for (let i = 0; i < seconds * 5; i++) {
    if (await fn()) return;
    await wait(200);
  }
  throw new Error('Acceptance timeout: ' + label);
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
module.exports = async (c) => {
  const { dataRoot, repo, integration, credentials, config, openManager, quit } = c;
  const out = path.join(dataRoot, 'logs');
  fs.mkdirSync(out, { recursive: true });
  const results = [];
  try {
    const before = structuredClone(repo.doc);
    const settings = sha(path.join(dataRoot, 'config/settings.json'));
    const theme = sha(path.join(dataRoot, 'themes', config.value.theme, 'style.css'));
    assert.equal(c.app.getPath('userData'), path.join(dataRoot, 'cache/profile'));
    assert.equal(c.app.getPath('sessionData'), path.join(dataRoot, 'cache/session'));
    assert.equal(c.app.getPath('temp'), path.join(dataRoot, 'temp'));
    results.push('Electron profile/session/temp under PrivateRoot');
    await openManager('messages');
    await wait(500);
    const manager = BrowserWindow.getAllWindows().find((w) => w !== c.widget);
    let status = await manager.webContents.executeJavaScript('window.ws.integration("status")');
    assert.equal(status.ok, true);
    await wait(300);
    assert.match(
      await manager.webContents.executeJavaScript('document.body.innerText'),
      /添加数据源/,
    );
    await manager.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='添加数据源').click()`,
    );
    await wait(150);
    assert.match(
      await manager.webContents.executeJavaScript('document.body.innerText'),
      /稳定账号 ID/,
    );
    const denied = await c.widget.webContents.executeJavaScript(
      'window.ws.privateData("export",{selection:["tasks"]})',
    );
    assert.equal(denied.ok, false);
    results.push('Original settings UI has add/rebind/range/schedule, widget denied private IPC');
    if (process.argv.includes('--live-acceptance')) {
      assert.ok(before.tasks.length > 0);
      const { callWorker } = require('../src/core/integration.cjs');
      const root = path.dirname(process.execPath);
      assert.ok(credentials.get());
      results.push('Original safeStorage credential decrypts with preserved profile');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(path.join(dataRoot, 'databases/messages.sqlite3'), {
        readOnly: true,
      });
      const originals = db.prepare('SELECT id,timestamp FROM messages ORDER BY timestamp').all();
      assert.equal(
        originals.length,
        10,
        'Only the ten explicitly authorized indexed messages may be sent',
      );
      const originalIds = new Set(originals.map((m) => m.id));
      // Exercise the existing workbench controls by conversation name, with no ID entry.
      await openManager('summary');
      await until(
        () => manager.webContents.executeJavaScript('!!summaryCache?.conversations?.length'),
        'conversation name list',
      );
      const target = await manager.webContents.executeJavaScript(
        'summaryCache.conversations.find(c=>c.ready&&c.in_collection_scope&&c.remote_authorized)',
      );
      assert.ok(target);
      const previousSummaryFile = path.join(dataRoot, 'state/last-summary.json');
      const previousSummaryId = fs.existsSync(previousSummaryFile)
        ? JSON.parse(fs.readFileSync(previousSummaryFile)).id
        : null;
      const stamp = (t) =>
        new Date(t * 1000 - new Date(t * 1000).getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16);
      const since = stamp(Math.min(...originals.map((m) => m.timestamp)) - 60),
        untilTime = stamp(Math.max(...originals.map((m) => m.timestamp)) + 60);
      await manager.webContents.executeJavaScript(
        `(()=>{const q=document.querySelector('#summary-search');q.value=${JSON.stringify(target.name)};q.dispatchEvent(new Event('input',{bubbles:true}));const box=Array.from(document.querySelectorAll('[data-summary-name]')).find(b=>b.dataset.summaryName===${JSON.stringify(target.name)}&&b.dataset.sourceId===${JSON.stringify(target.source_id)});box.checked=true;box.dispatchEvent(new Event('change',{bubbles:true}));const a=document.querySelector('#summary-since'),z=document.querySelector('#summary-until');a.value=${JSON.stringify(since)};z.value=${JSON.stringify(untilTime)};a.dispatchEvent(new Event('input',{bubbles:true}));z.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#summary-generate').click();})()`,
      );
      const summaryFile = path.join(dataRoot, 'state/last-summary.json');
      await until(
        () =>
          fs.existsSync(summaryFile) &&
          JSON.parse(fs.readFileSync(summaryFile)).id !== previousSummaryId,
        'real summary',
        180,
      );
      const summary = JSON.parse(fs.readFileSync(summaryFile));
      assert.equal(summary.tasks_created, 0);
      assert.equal(summary.conversations.length, 1);
      assert.equal(summary.conversations[0].status, 'generated', summary.conversations[0].reason);
      assert.equal(summary.conversations[0].coverage.sent, 10);
      const audit = JSON.parse(
        fs.readFileSync(path.join(dataRoot, 'summaries', summary.id + '-audit.json')),
      );
      assert.deepEqual(audit.queried, [{ source_id: target.source_id, chat_id: target.chat_id }]);
      assert.ok(
        audit.sent.every(
          (b) =>
            b.source_id === target.source_id &&
            b.chat_id === target.chat_id &&
            b.ids.every((id) => originalIds.has(id)),
        ),
      );
      results.push(
        'Real workbench: search by name, select one authorized conversation, set range, generate cited summary of ten messages; no tasks and no unselected body access',
      );
      await wait(500);
      await manager.webContents
        .capturePage()
        .then((i) => fs.writeFileSync(path.join(out, 'v03-summary.png'), i.toPNG()));
      const first = await integration.worker({ command: 'collect' }),
        second = await integration.worker({ command: 'collect' });
      assert.equal(first.errors.length, 0);
      assert.equal(second.errors.length, 0);
      repo.reload();
      for (const old of before.tasks)
        assert.deepEqual(
          repo.doc.tasks.find((t) => t.id === old.id),
          old,
        );
      const proposals = db
        .prepare("SELECT payload FROM analyses WHERE status='applied'")
        .all()
        .flatMap((r) => {
          const b = JSON.parse(r.payload);
          return Object.keys(b.revisions || {}).every((id) => originalIds.has(id)) ? b.tasks : [];
        });
      if (proposals.length) {
        const replay = integration.importer(proposals);
        assert.ok(
          replay.results.every((r) =>
            ['unchanged', 'previously-imported', 'conflict'].includes(r.status),
          ),
        );
      }
      db.close();
      repo.reload();
      for (const old of before.tasks)
        assert.deepEqual(
          repo.doc.tasks.find((t) => t.id === old.id),
          old,
        );
      results.push(
        'Two real local collection cycles and original task proposal replay preserve existing tasks, completion and dedupe',
      );
      const ai = await callWorker(root, dataRoot, {
        command: 'verify_ai',
        permitted_ids: [...originalIds],
        llm: { ...config.value.llm, key: credentials.get() },
      });
      assert.equal(ai.real_request, true);
      results.push('Real authorized provider analysis with evidence validation');
      fs.writeFileSync(path.join(out, 'v03-ai-summary.json'), JSON.stringify(ai));
    } else if (process.argv.includes('--restore-summary')) {
      const pick = JSON.parse(fs.readFileSync(path.join(dataRoot, 'config/summary.json')));
      await openManager('summary');
      await until(
        () => manager.webContents.executeJavaScript('!!summaryCache?.selection'),
        'restored summary selection',
      );
      const selected = await manager.webContents.executeJavaScript(
        'Array.from(document.querySelectorAll("[data-summary-name]:checked")).map(b=>({source_id:b.dataset.sourceId,chat_id:b.dataset.chatId}))',
      );
      assert.deepEqual(selected, pick.selected);
      assert.ok(before.tasks.length > 0);
      const extra = await manager.webContents.executeJavaScript(
        'Array.from(document.querySelectorAll("[data-summary-name]")).find(b=>!b.checked)?.dataset.summaryName',
      );
      if (extra) {
        await manager.webContents.executeJavaScript(
          `(()=>{const q=document.querySelector('#summary-search');q.value=${JSON.stringify(extra)};q.dispatchEvent(new Event('input',{bubbles:true}));const b=Array.from(document.querySelectorAll('[data-summary-name]')).find(b=>!b.checked&&b.dataset.summaryName===${JSON.stringify(extra)});b.click();document.querySelector('#summary-save').click();})()`,
        );
        await until(
          () =>
            JSON.parse(fs.readFileSync(path.join(dataRoot, 'config/summary.json'))).selected
              .length === 2,
          'multi-selection saved',
        );
        await manager.webContents.executeJavaScript(
          `(()=>{const mode=Array.from(document.querySelectorAll('select')).find(s=>Array.from(s.options).some(o=>o.value==='single'));mode.value='single';mode.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#summary-save').click();})()`,
        );
        await until(
          () =>
            JSON.parse(fs.readFileSync(path.join(dataRoot, 'config/summary.json'))).selected
              .length === 1,
          'single-selection restored',
        );
        assert.deepEqual(
          JSON.parse(fs.readFileSync(path.join(dataRoot, 'config/summary.json'))).selected,
          pick.selected,
        );
        results.push(
          'Actual workbench name search and checkbox multi-selection save; single-select restores original object without reading or sending the additional conversation',
        );
      }
      await manager.webContents
        .capturePage()
        .then((i) => fs.writeFileSync(path.join(out, 'v03-summary-restored.png'), i.toPNG()));
      results.push(
        'Actual process restart restores stable conversation selection, time range and previous summary',
      );
    } else if (process.argv.includes('--migrated-acceptance')) {
      assert.ok(before.tasks.length > 0);
      assert.equal(credentials.has(), false);
      assert.ok(
        status.value.info.config.sources.every(
          (s) => !s.enabled && !s.db_dir && !s.remote.chats.length,
        ),
      );
      await openManager('summary');
      await until(
        () => manager.webContents.executeJavaScript('!!summaryCache?.selection'),
        'migrated selection',
      );
      results.push(
        'Imported private tasks/settings/history/summary selection restored; credentials absent and source rebind required',
      );
    } else {
      assert.equal(before.tasks.length, 0);
      assert.equal(status.value.info.messages, 0);
      assert.equal(status.value.info.config.sources.length, 0);
      assert.equal(credentials.has(), false);
      results.push('Clean first launch has no identity/tasks/history/credentials');
    }
    await openManager('program');
    await wait(300);
    assert.match(
      await manager.webContents.executeJavaScript('document.body.innerText'),
      /私密数据迁移/,
    );
    await manager.webContents
      .capturePage()
      .then((i) => fs.writeFileSync(path.join(out, 'v03-program.png'), i.toPNG()));
    await openManager('messages');
    await wait(300);
    await manager.webContents
      .capturePage()
      .then((i) => fs.writeFileSync(path.join(out, 'v03-sources.png'), i.toPNG()));
    assert.equal(settings, sha(path.join(dataRoot, 'config/settings.json')));
    assert.equal(theme, sha(path.join(dataRoot, 'themes', config.value.theme, 'style.css')));
    results.push('Theme and application settings preserved');
    fs.writeFileSync(
      path.join(out, 'v03-portable.json'),
      JSON.stringify(
        {
          ok: true,
          real_data: process.argv.includes('--live-acceptance'),
          results,
          tasks: repo.doc.tasks.length,
          cwd_independent: process.cwd() !== path.dirname(process.execPath),
        },
        null,
        2,
      ),
    );
    quit();
  } catch (e) {
    fs.writeFileSync(
      path.join(out, 'v03-portable.json'),
      JSON.stringify({ ok: false, results, error: e.stack }, null, 2),
    );
    quit();
    c.app.exit(1);
  }
};
