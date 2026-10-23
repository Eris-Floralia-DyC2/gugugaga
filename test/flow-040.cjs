// Fixed Windows acceptance: real encrypted fixture databases and a loopback AI protocol server.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  http = require('node:http');
const { BrowserWindow, dialog, shell } = require('electron');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, seconds = 60) {
  for (let i = 0; i < seconds * 10; i++) {
    if (await fn()) return;
    await wait(100);
  }
  throw new Error('timeout: ' + label);
}
module.exports = async (c) => {
  const out = path.join(c.dataRoot, 'logs');
  fs.mkdirSync(out, { recursive: true });
  const checks = [];
  const normalTasks = () => c.repo.doc.tasks.filter((t) => !t.metadata?.groupConfirmation);
  const pass = (name) => checks.push({ name, status: 'pass' });
  let server;
  try {
    await c.integration.refresh();
    await c.openManager('messages');
    const m = BrowserWindow.getAllWindows().find((w) => w !== c.widget),
      js = (code) => m.webContents.executeJavaScript(code, true);
    await until(() => js('!!document.querySelector("#source-add")'), 'settings');
    const text = await js('document.body.innerText');
    assert.ok(!/启用本地语音|下载.*语音模型|允许外发|纳入采集|群稳定 ID|MCP 访问范围/.test(text));
    const mcpCard = await js(
      `Array.from(document.querySelectorAll('.settings-card')).find(c=>c.querySelector('h2')?.textContent==='MCP')?.querySelectorAll('button').length`,
    );
    assert.equal(mcpCard, 1);
    const mcpFile = path.join(c.dataRoot, 'config/mcp/server.json'),
      beforeMcp = fs.readFileSync(mcpFile, 'utf8');
    const open = shell.openPath;
    let folder = '';
    shell.openPath = async (p) => {
      folder = p;
      return '';
    };
    await js('document.querySelector("#mcp-open-folder").click()');
    await until(() => !!folder, 'folder action');
    shell.openPath = open;
    assert.equal(folder, path.join(c.dataRoot, 'config/mcp'));
    assert.ok(fs.existsSync(path.join(folder, 'README.txt')));
    assert.equal(fs.readFileSync(mcpFile, 'utf8'), beforeMcp);
    pass(
      'MCP UI has one folder button; actual PrivateRoot directory initialized, existing config unchanged, no server start (shell handoff captured)',
    );
    await c.openManager('llm');
    await until(
      () => js('!!document.querySelector("#ai-advanced-settings")'),
      'advanced AI settings',
    );
    const originalPrompt = c.integration.info.ai_features.summary.instructions;
    await js(
      `document.querySelector('#ai-advanced-settings').open=true; document.querySelector('#ai-summary-prompt').value='优先关注课程安排与截止日期。'; document.querySelector('#ai-summary-prompt').dispatchEvent(new Event('input')); document.querySelector('#ai-save-prompt').click()`,
    );
    await until(
      () =>
        !c.integration.running &&
        c.integration.info.ai_features.summary.instructions === '优先关注课程安排与截止日期。',
      'prompt persisted',
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(c.dataRoot, 'config/rules/ai-features.json'))).summary
        .instructions,
      '优先关注课程安排与截止日期。',
    );
    await c.openManager('messages');
    await c.openManager('llm');
    await until(
      () =>
        js(
          `document.querySelector('#ai-summary-prompt')?.value === '优先关注课程安排与截止日期。'`,
        ),
      'prompt reload',
    );
    await js(
      `document.querySelector('#ai-advanced-settings').open=true;document.querySelector('#ai-advanced-settings').scrollIntoView({block:'center'})`,
    );
    fs.writeFileSync(
      path.join(out, '050-advanced-prompt.png'),
      (await m.webContents.capturePage()).toPNG(),
    );
    await js(
      `document.querySelector('#ai-summary-prompt').value=${JSON.stringify(originalPrompt)};document.querySelector('#ai-summary-prompt').dispatchEvent(new Event('input'));document.querySelector('#ai-save-prompt').click()`,
    );
    await until(
      () =>
        !c.integration.running &&
        c.integration.info.ai_features.summary.instructions === originalPrompt,
      'prompt restored',
    );
    pass('Advanced AI prompt saves through actual UI/frozen worker and survives page reload');
    await c.openManager('messages');
    const fixtureFile = path.join(c.dataRoot, 'fixture-settings.json');
    if (process.argv.includes('--flow-live')) {
      const before = structuredClone(c.repo.doc),
        pick = JSON.parse(fs.readFileSync(path.join(c.dataRoot, 'config/summary.json')));
      assert.equal(before.tasks.length, 5);
      assert.ok(c.credentials.get());
      assert.equal(pick.selected.length, 1);
      await c.openManager('summary');
      await until(
        () => js('!!summaryCache && !!document.querySelector("#summary-search")'),
        'real directory',
      );
      const target = await js(
        `summaryCache.conversations.find(o=>o.source_id===${JSON.stringify(pick.selected[0].source_id)}&&o.chat_id===${JSON.stringify(pick.selected[0].chat_id)})`,
      );
      assert.ok(target?.ready);
      const liveStartedBefore = c.integration.progress?.startedAt;
      await js(
        `(()=>{const q=document.querySelector('#summary-search');q.value=${JSON.stringify(target.name.slice(0, 2))};q.dispatchEvent(new Event('input'));q.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));document.querySelector('#summary-generate').click()})()`,
      );
      await until(
        () => c.integration.progress?.startedAt !== liveStartedBefore,
        'fresh live summary',
      );
      await until(
        () => !c.integration.running && !!c.integration.lastResult?.conversations,
        'live summary',
        180,
      );
      const result = c.integration.lastResult;
      assert.equal(result.conversations[0].status, 'generated', result.conversations[0].reason);
      assert.equal(result.conversations[0].coverage.sent, 10);
      assert.equal(result.read, 10);
      assert.deepEqual(c.repo.doc, before);
      const audit = JSON.parse(
        fs.readFileSync(path.join(c.dataRoot, 'summaries', result.id + '-audit.json')),
      );
      assert.deepEqual(audit.queried, pick.selected);
      pass(
        'Real current-account metadata + exact ten-message recollection + configured remote AI summary through packaged workbench; no tasks or unselected body access',
      );
      await until(
        () => js('!document.querySelector("#summary-analyze").disabled'),
        'enabled analysis',
      );
      {
        const before = c.integration.progress?.startedAt;
        await js('document.querySelector("#summary-analyze").click()');
        await until(() => c.integration.progress?.startedAt !== before, 'fresh analysis');
      }
      await until(
        () => !c.integration.running && c.integration.lastResult?.action === 'tasks',
        'live task analysis',
        180,
      );
      const after = structuredClone(c.repo.doc);
      await until(
        () => js('!document.querySelector("#summary-analyze").disabled'),
        'enabled analysis',
      );
      {
        const before = c.integration.progress?.startedAt;
        await js('document.querySelector("#summary-analyze").click()');
        await until(() => c.integration.progress?.startedAt !== before, 'fresh analysis');
      }
      await until(() => !c.integration.running, 'live repeat', 180);
      assert.deepEqual(c.repo.doc, after);
      pass(
        'Real configured AI task analysis writes isolated original task-library copy; repeat creates no duplicate',
      );
      const openResult = await open(folder);
      assert.equal(openResult, '');
      pass('Windows file manager actually accepts the current PrivateRoot MCP folder');
    } else if (process.argv.includes('--flow-migration')) {
      assert.equal(normalTasks().length, 5);
      assert.equal(c.integration.info.config.version, 3);
      assert.ok(c.integration.info.config.sources.every((s) => !s.enabled && !s.db_dir));
      assert.equal(c.credentials.has(), false);
      await c.openManager('summary');
      await until(
        () => js('!!summaryCache && !!document.querySelector("#summary-search")'),
        'migrated selection',
      );
      assert.equal(await js('document.querySelectorAll("[data-summary-name]:checked").length'), 1);
      assert.ok(await js('document.body.innerText.includes("数据源")'));
      pass(
        'Actual private export/import starts in a new Chinese/space PrivateRoot with five tasks and saved selection; credentials absent, sources require rebind, no data loss',
      );
    } else if (!fs.existsSync(fixtureFile)) {
      assert.equal(normalTasks().length, 0);
      assert.equal(c.integration.info.config.sources.length, 0);
      assert.ok(!fs.existsSync(path.join(c.dataRoot, 'models/asr/model.bin')));
      pass('Clean first start has no account, task, history or model');
    } else if (process.argv.includes('--flow-restore')) {
      assert.equal(normalTasks().length, 1);
      assert.equal(c.config.value.appearance.signature, '统一流程 😊');
      await c.openManager('summary');
      await until(
        () => js('!!summaryCache && !!document.querySelector("#summary-search")'),
        'restored selection',
      );
      assert.equal(await js('document.querySelectorAll("[data-summary-name]:checked").length'), 1);
      assert.equal(
        await c.widget.webContents.executeJavaScript(
          'document.querySelector(".personal-signature").textContent',
        ),
        '统一流程 😊',
      );
      pass('Real restart restores saved selection, signature and imported task');
    } else {
      const fixture = JSON.parse(fs.readFileSync(fixtureFile));
      const oldAction = c.integration.action.bind(c.integration),
        worker = c.integration.worker.bind(c.integration);
      c.integration.action = async (command, payload = {}) => {
        const v = await oldAction(command, payload);
        // Provision a constructed, valid connection file using the real importer, before automatic reconnect.
        if (command === 'save_config')
          for (const s of v.config?.sources || []) {
            if (
              s.platform === 'wechat' &&
              s.db_dir === fixture.directory &&
              !fs.existsSync(path.join(c.dataRoot, 'secrets', 'wechat-' + s.id + '.dpapi'))
            )
              await worker({
                command: 'import_keys',
                source_id: s.id,
                path: fixture.connection_file,
              });
          }
        return v;
      };
      await js('document.querySelector("#source-add").click()');
      await wait(100);
      const picker = dialog.showOpenDialog;
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture.directory] });
      await js('document.querySelector("#source-choose-directory").click()');
      await until(
        () => js('!!document.querySelector("#source-directory").value'),
        'directory chosen',
      );
      dialog.showOpenDialog = picker;
      await js('document.querySelector("#source-save-connect").click()');
      await until(() => c.integration.info?.sources?.[0]?.connection?.ok, 'new source connected');
      const source = c.integration.info.config.sources[0];
      assert.ok(!('groups' in source) && !('remote' in source));
      assert.equal(c.integration.info.config.version, 3);
      pass(
        'Add source and connect: real UI, directory picker boundary, validated fixture DPAPI credentials, actual WeChat metadata',
      );
      const button = async (text) => {
        await until(
          () =>
            js(
              `Array.from(document.querySelectorAll('button')).some(b=>b.textContent===${JSON.stringify(text)}&&!b.disabled)`,
            ),
          'enabled button ' + text,
        );
        const before = c.integration.progress?.startedAt;
        await js(
          `Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)}).click()`,
        );
        if (
          [
            '检测连接',
            '生成总结',
            '执行任务分析',
            '停用数据源',
            '启用数据源',
            '修复图片读取',
            '清理未使用的缓存',
            '确认',
          ].includes(text)
        )
          await until(
            () => c.integration.progress?.startedAt !== before,
            'operation began ' + text,
          );
      };
      await button('检测连接');
      await until(() => !c.integration.running, 'test connection');
      await button('编辑或重新连接');
      await wait(150);
      await js(
        'document.querySelector("#source-account-name").value="本机验收账号";document.querySelector("#source-save-connect").click()',
      );
      await until(
        () =>
          !c.integration.running &&
          c.integration.info.config.sources[0].account_name === '本机验收账号',
        'edit saved',
      );
      assert.equal(c.integration.info.config.sources[0].id, source.id);
      pass('Edit and reconnect reuse verified credentials and retain stable source identity');
      let mode = 'success';
      const requests = [];
      server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (v) => (raw += v));
        req.on('end', () => {
          const payload = JSON.parse(raw);
          requests.push(payload);
          if (Array.isArray(payload.messages[1].content)) {
            setTimeout(() => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  choices: [
                    {
                      finish_reason: 'stop',
                      message: {
                        content: JSON.stringify({
                          text: '验收图片文字',
                          description: '绿色构造图片',
                          uncertainty: '',
                        }),
                      },
                    },
                  ],
                }),
              );
            }, 250);
            return;
          }
          const data = JSON.parse(payload.messages[1].content);
          assert.ok(
            !raw.includes('UNSELECTED_SECRET') &&
              !raw.includes('OUT_OF_RANGE') &&
              !raw.includes('PRIVATE_VOICE_CREDENTIAL') &&
              !raw.includes('PRIVATE_IMAGE_CREDENTIAL'),
          );
          if (mode === 'hang') return;
          if (mode === 'error') {
            res.writeHead(401);
            res.end('{}');
            return;
          }
          const item = data.messages.find((m) => m.text.includes('验收报告'));
          const summary = payload.messages[0].content.includes('会话总结助手');
          const value = summary
            ? {
                topics: [
                  { text: '提交验收报告', source_ids: [item.id], quote: '请在周五提交验收报告。' },
                ],
                notices: [],
                conclusions: [],
                uncertainties: [],
              }
            : {
                tasks: [
                  {
                    title: '提交验收报告',
                    description: '根据会话通知提交报告',
                    plan_date: c.snapshot().day,
                    due_date: null,
                    priority: 'normal',
                    source_ids: [item.id],
                    evidence: [{ message_id: item.id, quote: '请在周五提交验收报告。' }],
                    applies_to_me: true,
                    uncertainty: '',
                    confidence: 1,
                    existing_task_id: null,
                  },
                ],
                review_notes: [],
              };
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
              }),
            );
          }, 1300);
        });
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const config = structuredClone(c.config.value);
      config.llm.baseUrl = 'http://127.0.0.1:' + server.address().port;
      config.llm.model = 'fixture-model';
      config.llm.timeout = 3;
      c.config.save(config);
      c.credentials.set('fixture-key');
      await c.openManager('summary');
      await until(
        () => js('!!summaryCache && !!document.querySelector("#summary-search")'),
        'options',
      );
      const query = async (q) =>
        js(
          `(()=>{const input=document.querySelector('#summary-search');input.value=${JSON.stringify(q)};input.dispatchEvent(new Event('input'));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));})()`,
        );
      await js(
        `(()=>{const q=document.querySelector('#summary-search');q.value='备注';q.dispatchEvent(new CompositionEvent('compositionstart'));q.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,keyCode:229,bubbles:true}));q.dispatchEvent(new CompositionEvent('compositionend'));})()`,
      );
      assert.equal(await js('summaryUI.expanded'), false);
      await query('原始群');
      assert.equal(
        await js(
          'Array.from(document.querySelectorAll(".summary-option")).find(r=>!r.hidden).querySelector(".summary-name").textContent',
        ),
        '备注验收群',
      );
      await query('备注验');
      assert.equal(
        await js(
          'Array.from(document.querySelectorAll(".summary-option")).filter(x=>!x.hidden).length',
        ),
        1,
      );
      await js(`document.querySelector('[data-chat-id="${fixture.chat}"]').click()`);
      assert.equal(
        await js('document.querySelector("#summary-counter").textContent'),
        '已选 1 个会话',
      );
      assert.equal(
        await js(
          'document.querySelector(".summary-options > .summary-option").querySelector("input").dataset.chatId',
        ),
        fixture.chat,
      );
      await query('');
      await js(`document.querySelector('[data-chat-id="other@chatroom"]').click()`);
      assert.equal(
        await js('document.querySelector("#summary-counter").textContent'),
        '已选 2 个会话',
      );
      assert.equal(
        await js(
          'document.querySelector(".summary-options > .summary-option input").dataset.chatId',
        ),
        'other@chatroom',
      );
      await js(
        `document.querySelector('[data-chat-id="${fixture.chat}"]').click();document.querySelector('[data-chat-id="${fixture.chat}"]').click();dirty=false;render()`,
      );
      assert.equal(
        await js(
          'document.querySelector(".summary-options > .summary-option input").dataset.chatId',
        ),
        fixture.chat,
      );
      await js(`document.querySelector('[data-chat-id="other@chatroom"]').click()`);
      await query('无结果的名称');
      assert.match(
        await js('document.querySelector("#summary-search-status").textContent'),
        /没有找到/,
      );
      await query('备注验');
      assert.equal(requests.length, 0);
      await until(() => {
        try {
          return (
            JSON.parse(fs.readFileSync(path.join(c.dataRoot, 'config/summary.json'))).selected
              .length === 1
          );
        } catch {
          return false;
        }
      }, 'automatic save');
      const local = (v) =>
        new Date(v * 1000 - new Date(v * 1000).getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16);
      await js(
        `document.querySelector('#summary-since').value=${JSON.stringify(local(fixture.since))};document.querySelector('#summary-until').value=${JSON.stringify(local(fixture.until))};document.querySelector('#summary-since').dispatchEvent(new Event('input'));document.querySelector('#summary-until').dispatchEvent(new Event('input'));`,
      );
      const phases = [];
      c.integration.on('change', () => {
        if (c.integration.running) phases.push(c.integration.stage);
      });
      await button('生成总结');
      await until(() => c.integration.stage === '请求 AI', 'real AI phase');
      await js(`document.querySelector('[data-chat-id="${fixture.chat}"]').click()`);
      await wait(300);
      assert.match(
        await js('document.querySelector("#operation-progress").textContent'),
        /请求 AI|等待模型/,
      );
      assert.equal(
        await js('document.querySelector("#operation-progress progress").hasAttribute("value")'),
        false,
      );
      await until(
        () => !c.integration.running && c.integration.lastResult?.conversations,
        'summary complete',
      );
      await until(() => {
        try {
          return (
            JSON.parse(fs.readFileSync(path.join(c.dataRoot, 'config/summary.json'))).selected
              .length === 0
          );
        } catch {
          return false;
        }
      }, 'deselection saved');
      assert.equal(
        await js('document.querySelector("#summary-counter").textContent'),
        '已选 0 个会话',
      );
      await js(`document.querySelector('[data-chat-id="${fixture.chat}"]').click()`);
      assert.equal(normalTasks().length, 0);
      assert.equal(c.integration.lastResult.conversations[0].status, 'generated');
      assert.equal(c.repo.doc.tasks.filter((t) => t.metadata?.groupConfirmation).length, 1);
      assert.equal(
        c.repo.doc.tasks.find((t) => t.metadata?.groupConfirmation).metadata.groupConfirmation
          .incomplete,
        true,
      );
      assert.equal(c.integration.lastResult.read, 4);
      assert.ok(
        phases.includes('采集消息') && phases.includes('解析附件') && phases.includes('请求 AI'),
      );
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(path.join(c.dataRoot, 'databases/messages.sqlite3'), {
        readOnly: true,
      });
      assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n, 4);
      db.close();
      pass(
        'Name search + auto-save + unconfigured conversation collection + summary: real encrypted adapter/worker and loopback AI; exact range only, voice excluded, zero normal tasks; daily attachment confirmation allowed, live stages',
      );
      await button('执行任务分析');
      await until(
        () => !c.integration.running && c.integration.lastResult?.action === 'tasks',
        'task analysis',
      );
      assert.equal(normalTasks().length, 1);
      const task = structuredClone(normalTasks()[0]);
      await button('执行任务分析');
      await until(() => !c.integration.running, 'task repeat');
      assert.equal(normalTasks().length, 1);
      assert.deepEqual(normalTasks()[0], task);
      pass(
        'Task analysis shares acquired index and writes original TaskRepository; repeated execution creates no duplicate',
      );
      mode = 'error';
      // Change an actual cache input so the following checks exercise HTTP errors.
      const errorConfig = structuredClone(c.config.value);
      errorConfig.llm.model = 'fixture-error-model';
      c.config.save(errorConfig);
      await button('生成总结');
      await until(() => !c.integration.running && !!c.integration.error, 'error ends');
      assert.match(c.integration.error, /401/);
      mode = 'hang';
      await button('生成总结');
      await until(() => c.integration.stage === '请求 AI', 'cancel wait');
      await js('document.querySelector("#operation-cancel").click()');
      await until(() => !c.integration.running, 'cancel completes');
      assert.match(c.integration.error, /取消/);
      pass(
        'Provider failure and safe cancellation end the operation, retain index/tasks and report a specific error',
      );
      // Verify a real request timeout as distinct from cancellation.
      await button('生成总结');
      await until(() => !c.integration.running && !!c.integration.error, 'timeout ends', 40);
      assert.match(c.integration.error, /连接|响应|超时/);
      mode = 'success';
      pass(
        'Actual configured HTTP timeout/retry finishes with error; no permanent processing state',
      );
      await c.openManager('appearance');
      await wait(150);
      await js(
        `document.querySelector('#signature-input').value='统一流程 😊';document.querySelector('#signature-input').dispatchEvent(new Event('input'));document.querySelector('#signature-save').click()`,
      );
      await until(() => c.config.value.appearance.signature === '统一流程 😊', 'signature sync');
      await wait(250);
      assert.equal(
        await c.widget.webContents.executeJavaScript(
          'document.querySelector(".personal-signature").textContent',
        ),
        '统一流程 😊',
      );
      pass('Existing personal signature remains live on desktop and workbench');
      await c.openManager('messages');
      await wait(200);
      const manage = () =>
        js(
          `Array.from(document.querySelectorAll('summary')).find(s=>s.textContent==='管理').click()`,
        );
      await manage();
      await button('停用数据源');
      await until(
        () => !c.integration.running && !c.integration.info.config.sources[0].enabled,
        'disabled',
      );
      assert.equal(normalTasks().length, 1);
      await manage();
      await button('启用数据源');
      await until(
        () => !c.integration.running && c.integration.info.config.sources[0].enabled,
        'enabled',
      );
      const rebound = path.join(
        path.dirname(path.dirname(c.dataRoot)),
        '重绑客户端',
        'fixtureaccount',
        'db_storage',
      );
      fs.cpSync(fixture.directory, rebound, { recursive: true });
      await button('编辑或重新连接');
      await wait(100);
      const choose = dialog.showOpenDialog;
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [rebound] });
      await js('document.querySelector("#source-choose-directory").click()');
      await until(
        () => js(`document.querySelector('#source-directory').value===${JSON.stringify(rebound)}`),
        'rebind picker',
      );
      dialog.showOpenDialog = choose;
      await js('document.querySelector("#source-save-connect").click()');
      await until(
        () =>
          !c.integration.running &&
          c.integration.info.config.sources[0].db_dir === rebound &&
          c.integration.info.sources[0].connection.ok,
        'rebind repaired',
      );
      assert.equal(c.integration.info.config.sources[0].id, source.id);
      pass(
        'Disable/enable and real same-account directory rebind preserve task, identity and valid credentials',
      );
      await manage();
      await button('修复图片读取');
      await until(() => !c.integration.running && !!c.integration.error, 'image no sample ends');
      assert.match(c.integration.error, /无可验证|未找到/);
      await button('清理未使用的缓存');
      await until(() => !c.integration.running, 'cache cleanup');
      assert.ok(fs.existsSync(path.join(c.dataRoot, 'config/credential.dpapi')));
      await manage();
      await button('删除此源消息历史');
      await button('确认');
      await until(
        () => !c.integration.running && c.integration.info.messages === 0,
        'history deleted',
      );
      assert.equal(normalTasks().length, 1);
      await manage();
      await button('清除连接凭据');
      await button('确认');
      await until(
        () =>
          !c.integration.running &&
          !fs.existsSync(path.join(c.dataRoot, 'secrets', 'wechat-' + source.id + '.dpapi')),
        'credentials cleared',
      );
      assert.equal(normalTasks().length, 1);
      await worker({ command: 'import_keys', source_id: source.id, path: fixture.connection_file });
      await oldAction('connect_source', { source_id: source.id });
      pass(
        'Management actions have actual effects: image repair failure reason, cache cleanup, backed-up history deletion and credential clearing preserve tasks; validated import repairs connection',
      );
      await c.openManager('messages');
      await wait(100);
      await manage();
      await button('移除数据源');
      await button('确认');
      await until(
        () => !c.integration.running && c.integration.info.config.sources.length === 0,
        'removed',
      );
      assert.equal(normalTasks().length, 1);
      await js('document.querySelector("#source-add").click()');
      await wait(100);
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture.directory] });
      await js('document.querySelector("#source-choose-directory").click()');
      await until(() => js('!!document.querySelector("#source-directory").value'), 'readd picker');
      dialog.showOpenDialog = choose;
      await js('document.querySelector("#source-save-connect").click()');
      await until(
        () =>
          !c.integration.running &&
          c.integration.info.config.sources.length === 1 &&
          c.integration.info.sources[0].connection.ok,
        'readd connected',
      );
      assert.equal(c.integration.info.config.sources[0].id, source.id);
      assert.equal(normalTasks().length, 1);
      pass(
        'Remove/re-add same account restores stable source namespace and selection without deleting existing tasks',
      );
      fs.writeFileSync(path.join(out, '040-requests.json'), JSON.stringify(requests));
      c.integration.action = oldAction;
    }
    fs.writeFileSync(
      path.join(out, '040-flow.json'),
      JSON.stringify({ version: '0.5.0', checks }, null, 2),
    );
    if (server) {
      server.closeAllConnections();
      server.close();
    }
    c.quit();
  } catch (e) {
    checks.push({
      name: e.message,
      status: 'fail',
      stack: e.stack,
      operationError: c.integration.error,
      stage: c.integration.stage,
    });
    fs.writeFileSync(path.join(out, '040-flow.json'), JSON.stringify({ checks }, null, 2));
    if (server) {
      server.closeAllConnections();
      server.close();
    }
    c.app.exit(1);
  }
};
