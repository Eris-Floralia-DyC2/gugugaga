const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { BrowserWindow } = require('electron');
const { DatabaseSync } = require('node:sqlite');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = async (c) => {
  const out = path.join(c.dataRoot, 'validation/feishu-056');
  fs.mkdirSync(out, { recursive: true });
  const checks = [],
    errors = [];
  try {
    const before = JSON.stringify(c.repo.doc);
    await c.integration.worker({ command: 'feishu_daily_status' });
    fs.writeFileSync(
      path.join(c.dataRoot, 'config/feishu-daily.json'),
      JSON.stringify({
        version: 1,
        enabled: false,
        daily_time: '21:00',
        source: {
          id: 'feishu-daily',
          account_id: 'fixture',
          account_name: '模拟授权账号',
        },
        groups: [{ id: 'oc_fixture', name: '模拟课程群', start_date: '2026-11-01' }],
      }),
    );
    const db = new DatabaseSync(path.join(c.dataRoot, 'databases/feishu-daily.sqlite3'));
    const sections = {
      topics: [
        {
          text: '模拟课程安排：周五提交报告。',
          source_ids: ['fixture-message'],
          quote: '周五交报告',
        },
      ],
      notices: [],
      conclusions: [],
      followups: [],
      dates: [],
      attention: [],
    };
    const result = {
      date: '2026-11-01',
      sections,
      missing: ['模拟图片未解析'],
      has_text: true,
      sources: [
        {
          id: 'fixture-message',
          message_id: 'om_fixture',
          timestamp: 1793491200,
        },
      ],
    };
    db.prepare(
      'INSERT INTO days(account,chat,day,name,collected_until,content_hash,summary_hash,summary,complete,count,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      'fixture',
      'oc_fixture',
      '2026-11-01',
      '模拟课程群',
      1793566800,
      'hash',
      'hash',
      JSON.stringify(result),
      0,
      3,
      Date.now() / 1000,
    );
    db.close();
    await c.openManager('feishuDaily');
    const m = BrowserWindow.getAllWindows().find((w) => w !== c.widget);
    m.webContents.on('console-message', (_e, level, message) => {
      if (level >= 3) errors.push(message);
    });
    const js = (code) => m.webContents.executeJavaScript(code, true);
    async function until(fn, label) {
      for (let i = 0; i < 100; i++) {
        if (await fn()) return;
        await wait(100);
      }
      throw Error(label);
    }
    await until(
      () =>
        js(
          'document.body.innerText.includes("模拟课程群") && !!document.querySelector(".daily-summary")',
        ),
      'summary page',
    );
    checks.push('独立侧栏、真实 Chromium 与打包 worker 读取本地历史');
    await js('document.querySelector(".daily-summary").open=true');
    assert.match(await js('document.body.innerText'), /模拟课程安排/);
    assert.match(await js('document.body.innerText'), /待补全/);
    await js('document.querySelector(".feishu-settings").open=true');
    await js(
      'document.querySelector("input[type=time]").value="08:30"; document.querySelector("input[type=time]").dispatchEvent(new Event("change"))',
    );
    await until(
      async () =>
        JSON.parse(fs.readFileSync(path.join(c.dataRoot, 'config/feishu-daily.json')))
          .daily_time === '08:30',
      'time save',
    );
    checks.push('修改每日时间自动保存');
    await js(
      '{const boxes=[...document.querySelectorAll("input[type=checkbox]")]; const enabled=boxes[boxes.length-1]; enabled.checked=true; enabled.dispatchEvent(new Event("change"));}',
    );
    await until(
      async () =>
        JSON.parse(fs.readFileSync(path.join(c.dataRoot, 'config/feishu-daily.json'))).enabled,
      'enable save',
    );
    await js(
      '{const boxes=[...document.querySelectorAll("input[type=checkbox]")]; const enabled=boxes[boxes.length-1]; enabled.checked=false; enabled.dispatchEvent(new Event("change"));}',
    );
    await until(
      async () =>
        !JSON.parse(fs.readFileSync(path.join(c.dataRoot, 'config/feishu-daily.json'))).enabled,
      'pause save',
    );
    checks.push('启用与暂停自动保存；测试模式不访问真实飞书或模型');
    assert.equal(JSON.stringify(c.repo.doc), before);
    checks.push('待办仓库完全未改变');
    const denied = await c.widget.webContents.executeJavaScript(
      'window.ws.integration("feishu_daily_status")',
    );
    assert.equal(denied.ok, false);
    checks.push('小组件无法调用管理界面的飞书命令');
    await until(async () => !c.integration.running, 'settings operation finished');
    await wait(3500);
    await js(
      'document.querySelector(".feishu-settings").open=false; document.querySelector(".daily-summary").open=true; window.scrollTo(0,0)',
    );
    await m.webContents
      .capturePage()
      .then((im) => fs.writeFileSync(path.join(out, 'daily-summary.png'), im.toPNG()));
    assert.equal(errors.length, 0);
    checks.push('界面无脚本错误，摘要及未解析提示可见');
    fs.writeFileSync(
      path.join(out, 'result.json'),
      JSON.stringify(
        {
          passed: true,
          packaged: c.app.isPackaged,
          checks,
          fixture: true,
          live_llm: false,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ passed: true, checks }));
    c.quit();
  } catch (e) {
    fs.writeFileSync(
      path.join(out, 'result.json'),
      JSON.stringify({ passed: false, checks, error: e.stack, errors }, null, 2),
    );
    c.app.exit(1);
  }
};
