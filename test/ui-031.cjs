// Fixed packaged acceptance only, isolated by --smoke-test / WS_TEST_DATA.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { BrowserWindow } = require('electron');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  for (let i = 0; i < 300; i++) {
    if (await fn()) return;
    await wait(100);
  }
  throw new Error('timeout: ' + label);
}
module.exports = async (c) => {
  const out = path.join(c.dataRoot, 'logs');
  fs.mkdirSync(out, { recursive: true });
  const results = [];
  const check = (name) => results.push({ name, status: 'pass' });
  const original = structuredClone(c.repo.doc);
  try {
    await c.openManager('summary');
    const m = BrowserWindow.getAllWindows().find((w) => w !== c.widget);
    const js = (code) => m.webContents.executeJavaScript(code, true);
    await until(
      () => js('!!summaryCache && !!document.querySelector("#summary-search")'),
      'directory',
    );
    const actual = await js('summaryCache.conversations');
    if (await js('!!summaryCache.last_result')) {
      assert.equal(await js('summaryCache.last_result.tasks_created'), 0);
      assert.ok(
        await js('document.querySelector("#manager-content").textContent.includes("实际消息时间")'),
      );
      check(
        'Existing authorized summary and traceable coverage remain available without a new outbound request',
      );
    }
    const wechat = actual.filter((o) => o.platform === 'wechat' && o.ready);
    if (wechat.length) {
      assert.ok(wechat.some((o) => o.name_source === 'remark'));
      assert.ok(wechat.some((o) => o.name_source === 'nickname'));
      for (const o of wechat) {
        assert.equal(o.name, o.remark || o.nickname || o.chat_id);
      }
      const sample =
        wechat.find((o) => o.kind === 'group' && o.remark) || wechat.find((o) => o.remark);
      await js(
        `(()=>{const q=document.querySelector('#summary-search');q.value=${JSON.stringify(sample.remark.slice(0, 2))};q.dispatchEvent(new Event('input'));q.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));})()`,
      );
      assert.ok(
        await js(
          `Array.from(document.querySelectorAll('[data-summary-name]')).some(i=>i.dataset.sourceId===${JSON.stringify(sample.source_id)} && i.dataset.chatId===${JSON.stringify(sample.chat_id)} && !i.closest('.summary-option').hidden && i.closest('.summary-option').querySelector('.summary-name').textContent===${JSON.stringify(sample.remark)})`,
        ),
      );
      check(
        'Real current-account catalogue uses readable remarks, then nicknames, then stable identifiers; no body collection',
      );
      await m.webContents
        .capturePage()
        .then((i) => fs.writeFileSync(path.join(out, '031-real-directory.png'), i.toPNG()));
    }
    if (process.argv.includes('--ui-restore')) {
      assert.equal(c.config.value.appearance.signature, '重启保留 English 😊');
      assert.equal(
        await js('document.querySelector(".sidebar-caption").textContent'),
        '重启保留 English 😊',
      );
      assert.equal(
        await c.widget.webContents.executeJavaScript(
          'document.querySelector(".personal-signature").textContent',
        ),
        '重启保留 English 😊',
      );
      assert.equal(await js('document.querySelectorAll("[data-summary-name]:checked").length'), 1);
      check(
        'Actual process restart restores saved signature on both surfaces and stable summary selection',
      );
    } else {
      await js(`summaryCache={...summaryCache,conversations:[
        {source_id:'a',chat_id:'first',name:'备注甲',remark:'备注甲',nickname:'Alice',aliases:['备注甲','Alice'],platform:'wechat',account_id:'account-a',kind:'private',ready:true},
        {source_id:'a',chat_id:'second',name:'同名群',nickname:'同名群',platform:'wechat',account_id:'account-a',kind:'group',ready:true},
        {source_id:'b',chat_id:'third',name:'同名群',nickname:'同名群',platform:'wechat',account_id:'account-b',kind:'group',ready:true}],selection:{version:1,selected:[],since:1,until:10},last_result:null};render()`);
      const enter = async (value) =>
        js(
          `(()=>{let q=document.querySelector('#summary-search');q.value=${JSON.stringify(value)};q.dispatchEvent(new Event('input',{bubbles:true}));q.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));})()`,
        );
      const visible = () =>
        js(
          'Array.from(document.querySelectorAll(".summary-option")).filter(r=>!r.hidden).map(r=>r.querySelector("input").dataset.chatId)',
        );
      assert.deepEqual(await visible(), []);
      await js(
        `(()=>{let q=document.querySelector('#summary-search');q.value='Ali';q.dispatchEvent(new Event('input'));q.dispatchEvent(new CompositionEvent('compositionstart'));q.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,keyCode:229,bubbles:true}));q.dispatchEvent(new CompositionEvent('compositionend'));})()`,
      );
      assert.deepEqual(await visible(), []);
      await enter('ali');
      assert.deepEqual(await visible(), ['first']);
      assert.equal(await js('summaryCache.last_result'), null);
      check(
        'Packaged UI: Enter opens partial alias results; composition Enter does not search or generate (constructed IME events)',
      );
      await enter('不存在');
      assert.match(
        await js('document.querySelector("#summary-search-status").textContent'),
        /没有找到/,
      );
      await enter('同名');
      assert.deepEqual(await visible(), ['second', 'third']);
      const click = (id) =>
        js(
          `(()=>{const input=document.querySelector('[data-chat-id="${id}"]');input.focus();input.click();})()`,
        );
      await click('second');
      await click('third');
      assert.deepEqual(await visible(), ['third', 'second']);
      assert.equal(
        await js('document.querySelector("#summary-counter").textContent'),
        '已选 2 个会话',
      );
      assert.equal(await js('document.activeElement.dataset.chatId'), 'third');
      await enter('Ali');
      assert.deepEqual(await visible(), ['third', 'second', 'first']);
      await click('first');
      assert.deepEqual(await visible(), ['first', 'third', 'second']);
      await js('dirty=false;render()');
      assert.deepEqual(await visible(), ['first', 'third', 'second']);
      await js('dirty=false;WS.refresh()');
      await wait(300);
      assert.deepEqual(await visible(), ['first', 'third', 'second']);
      await click('third');
      assert.deepEqual(await visible(), ['first', 'second']);
      await click('second');
      assert.equal(
        await js('document.querySelector("#summary-counter").textContent'),
        '已选 1 个会话',
      );
      assert.equal(await js('document.querySelectorAll("[data-chat-id=first]").length'), 1);
      await enter('');
      await click('second');
      await click('third');
      await js(
        `(()=>{const mode=Array.from(document.querySelectorAll('select')).find(s=>s.querySelector('option[value="single"]'));mode.value='single';mode.dispatchEvent(new Event('change'));})()`,
      );
      assert.deepEqual(
        await js(
          'Array.from(document.querySelectorAll("[data-summary-name]:checked")).map(i=>i.dataset.chatId)',
        ),
        ['third'],
      );
      await js(
        `(()=>{const mode=Array.from(document.querySelectorAll('select')).find(s=>s.querySelector('option[value="multi"]'));mode.value='multi';mode.dispatchEvent(new Event('change'));})()`,
      );
      await click('third');
      await click('first');
      check(
        'Packaged UI: duplicate-name stable selection, immediate count, newest-first, focus, search/redraw/status retention and deselection',
      );
      await js('document.querySelector("#summary-save").click()');
      await until(
        () => fs.existsSync(path.join(c.dataRoot, 'config/summary.json')),
        'selection save',
      );
      await c.openManager('appearance');
      await wait(200);
      const save = async (value) => {
        await js(
          `(()=>{let q=document.querySelector('#signature-input');q.value=${JSON.stringify(value)};q.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#signature-save').click()})()`,
        );
        await until(() => c.config.value.appearance.signature === value, 'signature config');
        await wait(350);
        assert.equal(await js('document.querySelector(".sidebar-caption").textContent'), value);
        assert.equal(
          await c.widget.webContents.executeJavaScript(
            'document.querySelector(".personal-signature").textContent',
          ),
          value,
        );
      };
      await save('中文 English 😊 <img src=x onerror=alert(1)>');
      assert.equal(await js('document.querySelector(".sidebar-caption img")'), null);
      await save('长文字Long 😊 '.repeat(30));
      for (const zoom of [0.8, 1.25, 1.5]) {
        m.webContents.setZoomFactor(zoom);
        c.widget.webContents.setZoomFactor(zoom);
        await wait(120);
        assert.ok(
          await js('document.querySelector(".sidebar-caption").getBoundingClientRect().width<=166'),
        );
        assert.ok(
          await c.widget.webContents.executeJavaScript(
            'document.querySelector(".personal-signature").getBoundingClientRect().width < innerWidth',
          ),
        );
      }
      m.webContents.setZoomFactor(1);
      c.widget.webContents.setZoomFactor(1);
      await save('');
      assert.equal(await js('document.querySelector(".sidebar-caption").hidden'), true);
      assert.equal(
        await c.widget.webContents.executeJavaScript(
          'document.querySelector(".personal-signature").hidden',
        ),
        true,
      );
      await js('document.querySelector("#signature-reset").click()');
      await until(() => c.config.value.appearance.signature === null, 'default reset');
      await wait(300);
      assert.equal(
        await js('document.querySelector(".sidebar-caption").textContent'),
        '留一点空间，给今天。',
      );
      await save('重启保留 English 😊');
      check(
        'Packaged UI: preview/save, live widget/workbench sync, pure text, emoji, empty hiding, defaults, 80/125/150% zoom',
      );
      await m.webContents
        .capturePage()
        .then((i) => fs.writeFileSync(path.join(out, '031-signature.png'), i.toPNG()));
    }
    assert.deepEqual(c.repo.doc, original);
    check('Original task repository unchanged by all UI operations');
    fs.writeFileSync(
      path.join(out, '031-ui.json'),
      JSON.stringify({ version: 1, results }, null, 2),
    );
    c.quit();
  } catch (e) {
    results.push({ name: e.message, status: 'fail', stack: e.stack });
    fs.writeFileSync(
      path.join(out, '031-ui.json'),
      JSON.stringify({ version: 1, results }, null, 2),
    );
    c.app.exit(1);
  }
};
