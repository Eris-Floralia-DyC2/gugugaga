const fs = require('node:fs'),
  path = require('node:path'),
  http = require('node:http'),
  assert = require('node:assert/strict');
const { BrowserWindow } = require('electron');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  for (let i = 0; i < 400; i++) {
    if (await fn()) return;
    await wait(100);
  }
  throw Error(label);
}
module.exports = async (c) => {
  const checks = [],
    out = path.join(c.dataRoot, 'validation/053');
  fs.mkdirSync(out, { recursive: true });
  let server;
  const pass = (name) => checks.push({ name, status: 'pass' });
  try {
    const fixture = JSON.parse(fs.readFileSync(path.join(c.dataRoot, 'fixture-settings.json')));
    let config = (await c.integration.worker({ command: 'status' })).config;
    const saved = await c.integration.worker({
      command: 'save_config',
      config: {
        ...config,
        enabled: false,
        sources: [
          {
            id: 'fixture-source',
            platform: 'wechat',
            account_id: 'fixtureaccount',
            account_name: '验收账号',
            db_dir: fixture.directory,
            enabled: true,
          },
        ],
      },
    });
    const source = saved.config.sources[0];
    await c.integration.worker({
      command: 'import_keys',
      source_id: source.id,
      path: fixture.connection_file,
    });
    await c.integration.action('connect_source', { source_id: source.id });
    await c.openManager('llm');
    const settingsWindow = BrowserWindow.getAllWindows().find((w) => w !== c.widget);
    const sj = (code) => settingsWindow.webContents.executeJavaScript(code, true);
    await until(
      () => sj('!!document.querySelector("#ai-summary-prompt")'),
      'separate feature fields',
    );
    await sj(
      `document.querySelector('#ai-advanced-settings').open=true;for(const [id,value] of Object.entries({'ai-summary-prompt':'仅概括课程讨论。','ai-task-prompt':'仅提取明确作业。','ai-summary-max-tokens':8192,'ai-task-max-tokens':2048})){const n=document.getElementById(id);n.value=value;n.dispatchEvent(new Event('input'))}document.querySelector('#ai-save-prompt').click()`,
    );
    await until(
      () => !c.integration.running && c.integration.info.ai_features.summary.max_tokens === 8192,
      'features persisted',
    );
    await c.openManager('messages');
    await c.openManager('llm');
    await until(
      () => sj(`document.querySelector('#ai-task-prompt')?.value==='仅提取明确作业。'`),
      'features reload',
    );
    assert.equal(
      await sj(`document.querySelector('#ai-summary-prompt').value`),
      '仅概括课程讨论。',
    );
    assert.equal(
      await sj(`document.querySelectorAll('#ai-advanced-settings textarea[readonly]').length`),
      2,
    );
    await sj(
      `document.querySelector('#ai-advanced-settings').open=true;document.querySelector('#ai-advanced-settings').scrollIntoView({block:'start'})`,
    );
    fs.writeFileSync(
      path.join(out, '独立提示词与输出上限.png'),
      (await settingsWindow.webContents.capturePage()).toPNG(),
    );
    pass(
      'Independent feature prompts and output limits save through actual UI, survive reload and disclose built-in prompts',
    );
    await c.openManager('summary');
    const m = BrowserWindow.getAllWindows().find((w) => w !== c.widget),
      js = (code) => m.webContents.executeJavaScript(code, true),
      wj = (code) => c.widget.webContents.executeJavaScript(code, true);
    await until(
      () => js('!!summaryCache && !!document.querySelector("#summary-since")'),
      'summary default window',
    );
    const bounds = await js(
      '[document.querySelector("#summary-since").value,document.querySelector("#summary-until").value]',
    );
    const local = (d) =>
      new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
    const start = new Date();
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 0);
    assert.deepEqual(
      bounds.map((v) => new Date(v).getTime()),
      [start.getTime(), end.getTime()],
    );
    pass('Default UI range uses local yesterday midnight through today 23:59:59');
    await until(() => wj('!!document.querySelector("[data-slot=date]")'), 'widget date');
    const dateHeight = await wj(
      'document.querySelector("[data-slot=date]").getBoundingClientRect().height',
    );
    await wj(
      'document.querySelector("[data-slot=date]").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))',
    );
    await until(() => c.config.value.appearance.dateCollapsed === true, 'collapse persisted');
    await until(
      () => wj('document.querySelector("[data-slot=date]").classList.contains("date-collapsed")'),
      'collapse rendered',
    );
    assert.ok(
      (await wj('document.querySelector("[data-slot=date]").getBoundingClientRect().height')) <
        dateHeight - 15,
    );
    c.widget.webContents.reload();
    await until(
      () => wj('!!document.querySelector("[data-slot=date].date-collapsed")'),
      'collapse after reload',
    );
    assert.equal(
      await wj('document.querySelector("[data-slot=date]").getBoundingClientRect().height'),
      16,
    );
    assert.equal(
      await wj('getComputedStyle(document.querySelector(".widget-shell")).rowGap'),
      '12px',
    );
    pass('Collapsed layout reduces date height to 16px and shared upper gaps to 12px');
    fs.writeFileSync(
      path.join(out, '日期区域折叠.png'),
      (await c.widget.webContents.capturePage()).toPNG(),
    );
    await wj(
      'document.querySelector("[data-slot=date]").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))',
    );
    await until(() => c.config.value.appearance.dateCollapsed === false, 'expand');
    pass(
      'Double-click collapses any date area; saved collapse survives renderer reload and double-click expands',
    );
    c.integration.error = '消息同步异常';
    c.integration.info.sources[0].health = { ok: false, stage: 'analysis', reason: '消息分析异常' };
    c.broadcast();
    await wait(300);
    assert.ok(
      !/消息同步异常|消息分析异常/.test(
        await wj('document.querySelector("[data-slot=status]").innerText'),
      ),
    );
    c.integration.error = null;
    pass('Pipeline problems do not appear in desktop footer');
    c.integration.progress = {
      stage: '完成',
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
      done: 1,
      total: 1,
      detail: '验收完成',
    };
    c.integration.running = false;
    c.broadcast();
    await until(
      () => js('getComputedStyle(document.querySelector("#operation-progress")).display!=="none"'),
      'finished operation visible',
    );
    await wait(5300);
    assert.equal(
      await js('getComputedStyle(document.querySelector("#operation-progress")).display'),
      'none',
    );
    pass('Operation panel actually disappears after five seconds including CSS display');
    let summaries = 0,
      tasks = 0,
      repairSent = false;
    const taskInputs = [];
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (x) => (raw += x));
      req.on('end', () => {
        try {
          const payload = JSON.parse(raw),
            input = JSON.parse(payload.messages[1].content),
            rows = input.messages;
          let answer;
          if (payload.messages[0].content.includes('会话总结助手')) {
            assert.equal(payload.max_tokens, 8192);
            assert.ok(payload.messages[0].content.includes('仅概括课程讨论。'));
            assert.ok(!payload.messages[0].content.includes('仅提取明确作业。'));
            summaries++;
            answer = {
              topics: [{ text: '课程通知', source_ids: [rows[0].id], quote: rows[0].text }],
              notices: [],
              conclusions: [],
              uncertainties: [],
            };
          } else {
            assert.equal(payload.max_tokens, 2048);
            assert.ok(payload.messages[0].content.includes('仅提取明确作业。'));
            assert.ok(!payload.messages[0].content.includes('仅概括课程讨论。'));
            tasks++;
            taskInputs.push(rows.map((r) => r.text));
            const item = rows.find((r) => /提交/.test(r.text));
            answer = { tasks: [], review_notes: [], useful_information: [] };
            if (item) {
              const later = item.text.includes('新增');
              const ids = [item.id];
              if (!repairSent && rows.length > 1) {
                ids.push(rows.find((r) => r.id !== item.id).id);
                repairSent = true;
              }
              answer.tasks = [
                {
                  title: later ? '提交新增实验作业' : '提交验收报告',
                  description: '按课程通知提交',
                  plan_date: input.today,
                  due_date: null,
                  priority: 'normal',
                  source_ids: ids,
                  evidence: [{ message_id: item.id, quote: item.text }],
                  applies_to_me: true,
                  uncertainty: '',
                  confidence: 0.99,
                  existing_task_id: null,
                },
              ];
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }],
            }),
          );
        } catch {
          res.writeHead(500);
          res.end('{}');
        }
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    c.config.save({
      ...c.config.value,
      llm: {
        ...c.config.value.llm,
        baseUrl: 'http://127.0.0.1:' + server.address().port,
        model: 'fixture',
        thinking: 'disabled',
      },
    });
    c.credentials.set('fixture-secret');
    await c.integration.refresh();
    await js(
      `document.querySelector('#summary-since').value=${JSON.stringify(local(new Date(fixture.since * 1000)))};document.querySelector('#summary-until').value=${JSON.stringify(local(new Date(fixture.until * 1000)))};document.querySelector('#summary-since').dispatchEvent(new Event('input'));document.querySelector('#summary-until').dispatchEvent(new Event('input'));`,
    );
    const select = async (chat) => {
      await js(
        `(()=>{const input=Array.from(document.querySelectorAll('[data-summary-name]')).find(i=>i.dataset.chatId===${JSON.stringify(chat)});input.checked=true;input.dispatchEvent(new Event('change'));})()`,
      );
      await js('summarySaveChain');
    };
    await select(fixture.chat);
    const click = async (id) => {
      await until(
        () => js(`!!document.querySelector('#${id}')&&!document.querySelector('#${id}').disabled`),
        'button ' + id,
      );
      const old = c.integration.progress?.startedAt;
      await js(`document.querySelector('#${id}').click()`);
      await until(() => c.integration.progress?.startedAt !== old, 'begin ' + id);
      await until(() => !c.integration.running && c.integration.stage === '完成', 'finish ' + id);
      await until(() => js(`!document.querySelector('#${id}').disabled`), 'enabled ' + id);
    };
    await click('summary-generate');
    assert.equal(summaries, 1);
    await click('summary-generate');
    assert.equal(summaries, 1);
    assert.equal(c.integration.lastResult.conversations[0].status, 'cached');
    await select(fixture.other);
    await click('summary-generate');
    assert.equal(summaries, 2);
    assert.deepEqual(
      c.integration.lastResult.conversations.map((r) => r.status),
      ['cached', 'generated'],
    );
    pass(
      'Adding a conversation generates only its summary; unchanged previous conversation is reused',
    );
    await js('document.querySelectorAll("details").forEach(d=>d.open=true)');
    assert.ok(
      !/[a-f0-9]{64}/i.test(await js('document.querySelector("#manager-content").innerText')),
    );
    pass(
      'Expanded management details and citations contain readable names instead of internal hashes',
    );
    await click('summary-analyze');
    assert.ok(repairSent);
    assert.equal(c.repo.doc.tasks.filter((t) => !t.metadata?.groupConfirmation).length, 1);
    const previousTasks = tasks;
    await click('summary-analyze');
    assert.equal(tasks, previousTasks);
    pass(
      'Task citation gap is repaired through actual HTTP/frozen worker and existing importer; repeat skips processed messages',
    );
    fs.copyFileSync(
      path.join(c.dataRoot, 'fixture-update.dat'),
      path.join(fixture.directory, 'message/message_0.db'),
    );
    await click('summary-analyze');
    assert.equal(tasks, previousTasks + 1);
    assert.equal(c.repo.doc.tasks.filter((t) => !t.metadata?.groupConfirmation).length, 2);
    assert.deepEqual(taskInputs.at(-1), ['请提交新增实验作业。']);
    pass('Later message in an existing conversation reaches AI alone and imports one new task');
    await js('document.querySelector("#summary-generate").scrollIntoView({block:"center"})');
    fs.writeFileSync(
      path.join(out, '会话与分析结果.png'),
      (await m.webContents.capturePage()).toPNG(),
    );
    await until(
      () => wj('document.body.innerText.includes("提交新增实验作业")'),
      'desktop auto refresh',
    );
    pass('New task imports automatically appear on the desktop widget');
    const tasksBefore = JSON.stringify(c.repo.doc),
      dbBefore = fs.readFileSync(path.join(c.dataRoot, 'databases/messages.sqlite3'));
    const historyBefore = fs.readdirSync(path.join(c.dataRoot, 'summaries')).sort();
    c.integration.lastTaskResult.review = ['验收待确认内容'];
    c.integration.lastTaskResult.usefulInformation = [{ text: '验收重要消息' }];
    c.broadcast();
    await until(
      () => js('document.body.innerText.includes("验收重要消息")'),
      'visible result messages',
    );
    await js(
      `Array.from(document.querySelectorAll('button')).find(n=>n.textContent==='清空下方消息').click()`,
    );
    await until(
      () =>
        js(
          '!document.body.innerText.includes("验收重要消息")&&!document.body.innerText.includes("验收待确认内容")',
        ),
      'cleared result messages',
    );
    assert.equal(JSON.stringify(c.repo.doc), tasksBefore);
    assert.ok(
      fs.readFileSync(path.join(c.dataRoot, 'databases/messages.sqlite3')).equals(dbBefore),
    );
    assert.deepEqual(fs.readdirSync(path.join(c.dataRoot, 'summaries')).sort(), historyBefore);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(c.dataRoot, 'state/last-summary.json'))),
      null,
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(c.dataRoot, 'state/last-task-result.json')))
        .usefulInformation,
      [],
    );
    const reloaded = new Promise((resolve) =>
      settingsWindow.webContents.once('did-finish-load', resolve),
    );
    settingsWindow.webContents.reload();
    await reloaded;
    await c.openManager('summary');
    await until(() => js('!!summaryCache'), 'results reload');
    assert.ok(!(await js('document.body.innerText.includes("验收重要消息")')));
    pass(
      'Clear-result button persists empty messages and removes latest summary display while retaining original tasks, history and analysis index',
    );
    fs.writeFileSync(
      path.join(out, 'result.json'),
      JSON.stringify(
        {
          version: '0.5.3',
          checks,
          model:
            'Loopback synthetic responses; real Chromium, encrypted source, frozen worker, task importer and files',
          summaries,
          tasks,
        },
        null,
        2,
      ),
    );
    server.closeAllConnections();
    server.close();
    c.quit();
  } catch (e) {
    fs.writeFileSync(
      path.join(out, 'result.json'),
      JSON.stringify(
        { checks, error: e.stack, operationError: c.integration.error, stage: c.integration.stage },
        null,
        2,
      ),
    );
    if (server) {
      server.closeAllConnections();
      server.close();
    }
    c.app.exit(1);
  }
};
