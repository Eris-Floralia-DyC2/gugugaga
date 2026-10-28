/* Real Electron / Windows integration tests. Isolated WS_TEST_DATA only. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { BrowserWindow, nativeImage } = require('electron');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  for (let i = 0; i < 40; i++) {
    if (await fn()) return;
    await wait(100);
  }
  throw new Error('等待失败：' + label);
}
module.exports = async function (ctx) {
  if (process.argv.includes('--deadline-test')) return require('./deadline.cjs')(ctx);
  const {
    app,
    widget,
    repo,
    config,
    credentials,
    themes,
    native,
    dataRoot,
    snapshot,
    bounds,
    setBounds,
    quit,
    openManager,
    hideWidget,
    showWidget,
  } = ctx;
  const results = [];
  const out = path.join(dataRoot, 'logs', 'smoke');
  fs.mkdirSync(out, { recursive: true });
  const test = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, status: 'pass', detail });
    } catch (e) {
      results.push({ name, status: 'fail', error: e.message, stack: e.stack });
    }
  };
  const js = (s) => widget.webContents.executeJavaScript(s);
  let rendererErrors = [];
  widget.webContents.on('console-message', (_e, _level, message) => {
    if (typeof message === 'string' && /error|failed|refused/i.test(message))
      rendererErrors.push(message);
  });
  await wait(800);
  await test('真实 Chromium 页面与受控 IPC 加载', async () => {
    const title = await js('document.title');
    assert.match(title, /WS/);
    assert.equal(await js('typeof window.require'), 'undefined');
    assert.equal(await js('typeof window.ws.snapshot'), 'function');
    assert.equal(await js('document.querySelectorAll("[data-slot=today]").length'), 1);
    assert.equal(await js('document.querySelector("#toast").textContent'), '');
    return title;
  });
  await test('真实任务文件写入、同步 GUI、完成与撤销', async () => {
    let s = repo.snapshot();
    repo.apply(
      { type: 'add', task: { title: '完成 WS 第一版验收', priority: 'high' } },
      s.revision,
    );
    repo.apply(
      {
        type: 'add',
        task: {
          title: '为明天留一点空间',
          description: '这条任务用于隔离环境测试，不会写入个人任务。',
        },
      },
      repo.revision,
    );
    const old = new Date();
    old.setDate(old.getDate() - 1);
    const planDate = require('../src/core/tasks.cjs').today(old);
    repo.apply({ type: 'add', task: { title: '整理昨天的灵感', planDate } }, repo.revision);
    await wait(300);
    assert.match(await js('document.body.innerText'), /整理昨天的灵感/);
    const task = repo.doc.tasks[0];
    repo.apply({ type: 'toggle', id: task.id }, repo.revision);
    await wait(200);
    assert.equal(await js('document.querySelectorAll(".completed").length'), 1);
    repo.apply({ type: 'toggle', id: task.id }, repo.revision);
    await wait(200);
    return { taskCount: repo.doc.tasks.length };
  });
  await test('真实外部 HTML/CSS 热更新及脚本注入阻止', async () => {
    const folder = path.join(themes.dir, 'default');
    const htmlFile = path.join(folder, 'widget.html'),
      cssFile = path.join(folder, 'style.css');
    const html = fs.readFileSync(htmlFile, 'utf8'),
      css = fs.readFileSync(cssFile, 'utf8');
    try {
      fs.writeFileSync(
        htmlFile,
        html.replace('DAYSPACE', 'HOT RELOAD') + '<script>window.__themeAttack=1</script>',
      );
      fs.writeFileSync(cssFile, css + '\n.brand { letter-spacing: 3px; }');
      await wait(1200);
      assert.match(await js('document.body.textContent'), /HOT RELOAD/);
      assert.equal(
        await js('getComputedStyle(document.querySelector(".brand")).letterSpacing'),
        '3px',
      );
      assert.equal(await js('window.__themeAttack'), undefined);
      fs.writeFileSync(htmlFile, '<div>broken theme</div>');
      await wait(1200);
      assert.equal(await js('document.querySelectorAll("[data-slot=today]").length'), 1);
    } finally {
      fs.writeFileSync(htmlFile, html);
      fs.writeFileSync(cssFile, css);
      await wait(1000);
    }
  });
  await test('真实 Windows DPAPI 加密与秘密不出现在配置快照', async () => {
    credentials.set('ws-smoke-secret-not-real');
    assert.equal(credentials.get(), 'ws-smoke-secret-not-real');
    assert.ok(!fs.readFileSync(credentials.file, 'utf8').includes('ws-smoke-secret'));
    assert.ok(!JSON.stringify(snapshot()).includes('ws-smoke-secret'));
    credentials.set('');
  });
  await test('桌面层原生父子窗口 / 设置置顶 / 切回', async () => {
    const b = bounds();
    const c = structuredClone(config.value);
    c.mode = 'topmost';
    config.save(c);
    await wait(200);
    assert.equal(native.api.parent(native.hwnd(widget)), null);
    c.mode = 'desktop';
    config.save(c);
    await wait(200);
    assert.ok(native.api.parent(native.hwnd(widget)));
    assert.deepEqual(bounds(), b);
    return native.diagnostics(widget);
  });
  await test('实际原生坐标设置、尺寸与负坐标工作区转换', async () => {
    const b = bounds();
    setBounds({ ...b, x: b.x - 25, y: b.y - 20, width: b.width + 20, height: b.height + 30 });
    await wait(150);
    const next = bounds();
    assert.ok(Math.abs(next.width - b.width - 20) <= 1);
    assert.ok(Math.abs(next.x - b.x + 25) <= 1);
    setBounds(b);
  });
  await test('真实双显示器与混合 DPI 移动、切换模式保持尺寸', async () => {
    const b = bounds();
    const { screen } = require('electron');
    const displays = screen.getAllDisplays();
    const records = [];
    for (const display of displays) {
      const target = require('../src/windows/geometry.cjs').defaultBounds(display.workArea);
      setBounds(target);
      await wait(250);
      const moved = bounds();
      for (const key of ['x', 'y', 'width', 'height'])
        assert.ok(Math.abs(moved[key] - target[key]) <= 1, key);
      for (const mode of ['topmost', 'desktop']) {
        const c = structuredClone(config.value);
        c.mode = mode;
        config.save(c);
        await wait(200);
        for (const key of ['x', 'y', 'width', 'height'])
          assert.ok(Math.abs(bounds()[key] - target[key]) <= 1, 'mode ' + mode + ' ' + key);
      }
      records.push({ display: String(display.id), scale: display.scaleFactor, bounds: bounds() });
    }
    setBounds(b);
    return records;
  });
  await test('实际收起与恢复不改变位置和尺寸', async () => {
    const b = bounds();
    hideWidget();
    assert.equal(native.api.visible(native.hwnd(widget)), false);
    showWidget();
    await wait(120);
    assert.equal(native.api.visible(native.hwnd(widget)), true);
    assert.deepEqual(bounds(), b);
  });
  await test('125%非整像素坐标下反复切换不累计尺寸漂移', async () => {
    const old = bounds();
    const { screen } = require('electron');
    const d =
      screen.getAllDisplays().find((d) => d.scaleFactor === 1.25) || screen.getPrimaryDisplay();
    const target = { x: d.workArea.x + 137, y: d.workArea.y + 83, width: 403, height: 587 };
    setBounds(target);
    await wait(160);
    for (let i = 0; i < 6; i++) {
      const c = structuredClone(config.value);
      c.mode = i % 2 ? 'desktop' : 'topmost';
      config.save(c);
      await wait(170);
      assert.deepEqual(bounds(), target);
    }
    setBounds(old);
  });
  await test('真实 PNG / GIF / APNG 解码与动画帧变化', async () => {
    const fixtures = path.resolve(__dirname, 'fixtures');
    if (!fs.existsSync(fixtures))
      return 'Fixtures omitted in packaged build; covered by development smoke';
    let last;
    for (const file of ['static.png', 'animated.gif', 'animated.apng']) {
      fs.copyFileSync(path.join(fixtures, file), path.join(dataRoot, 'backgrounds', file));
      const c = structuredClone(config.value);
      c.mode = 'topmost';
      c.appearance.particles = false;
      c.appearance.background = file;
      config.save(c);
      await until(
        () =>
          js(
            '!!document.querySelector("#background").naturalWidth && !WS.effects.status().pausedImage',
          ),
        '背景载入与暂停状态恢复 ' + file,
      );
      const loaded = await js(
        '({complete:document.querySelector("#background").complete,width:document.querySelector("#background").naturalWidth})',
      );
      assert.ok(loaded.complete && loaded.width > 0, file + ' decode');
      if (file !== 'static.png') {
        const sample = async () => [
          ...(
            await widget.webContents.capturePage({ x: 20, y: 20, width: 1, height: 1 })
          ).toBitmap(),
        ];
        const a = await sample();
        await wait(180);
        const b = await sample();
        if (JSON.stringify(a) === JSON.stringify(b)) {
          await wait(160);
          assert.notDeepEqual(await sample(), a, file + ' animated frame');
        } else assert.notDeepEqual(a, b);
      }
    }
    const c = structuredClone(config.value);
    c.appearance.background = '';
    c.appearance.particles = true;
    config.save(c);
  });
  await test('真实 Chromium 降载：GIF/APNG 静态帧替代并卸载动画源', async () => {
    const file = path.join(dataRoot, 'backgrounds', 'animated.gif');
    if (!fs.existsSync(file)) return 'development smoke only';
    const c = structuredClone(config.value);
    c.appearance.background = 'animated.gif';
    config.save(c);
    await wait(220);
    await js('WS.effects.setPerformance({paused:true,eco:true,fps:0})');
    assert.equal(await js('document.querySelector("#background").getAttribute("src")'), null);
    assert.equal(
      await js('getComputedStyle(document.querySelector("#frozen-background")).display'),
      'block',
    );
    await js('WS.effects.setPerformance({paused:false,eco:false,fps:30})');
    const d = structuredClone(config.value);
    d.appearance.background = '';
    config.save(d);
  });
  await test('实际管理窗口与双窗口数据同步', async () => {
    await openManager('tasks');
    await wait(500);
    const m = BrowserWindow.getAllWindows().find((w) => w !== widget);
    assert.ok(m);
    assert.match(
      await m.webContents.executeJavaScript('document.body.innerText'),
      /完成 WS 第一版验收/,
    );
    const denied = await widget.webContents.executeJavaScript('window.ws.credential("forbidden")');
    assert.equal(denied.ok, false);
    await m.webContents
      .capturePage()
      .then((i) => fs.writeFileSync(path.join(out, 'manager.png'), i.toPNG()));
    m.close();
  });
  await test('真实窗口帧截图', async () => {
    const im = await widget.webContents.capturePage();
    fs.writeFileSync(path.join(out, 'widget.png'), im.toPNG());
    assert.ok(!im.isEmpty());
  });
  await test('消息设置入口与受控后台状态', async () => {
    await openManager('messages');
    await wait(500);
    const manager = BrowserWindow.getAllWindows().find((w) => w !== widget);
    const status = await manager.webContents.executeJavaScript('window.ws.integration("status")');
    assert.equal(status.ok, true);
    assert.equal(status.value.info.config.version, 3);
    await wait(500);
    assert.match(await manager.webContents.executeJavaScript('document.body.innerText'), /数据源/);
    const denied = await widget.webContents.executeJavaScript('window.ws.integration("collect")');
    assert.equal(denied.ok, false);
    const unknown = await manager.webContents.executeJavaScript(
      'window.ws.integration("arbitrary_command")',
    );
    assert.equal(unknown.ok, false);
    await manager.webContents
      .capturePage()
      .then((i) => fs.writeFileSync(path.join(out, 'messages.png'), i.toPNG()));
    manager.close();
  });
  const report = {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    os: require('node:os').release(),
    electron: process.versions.electron,
    packaged: app.isPackaged,
    results,
    rendererErrors,
    displays: snapshot().displays,
    windows: native.diagnostics(widget),
  };
  fs.writeFileSync(path.join(out, 'smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  quit();
  if (results.some((r) => r.status === 'fail')) app.exit(1);
};
