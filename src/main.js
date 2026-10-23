const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  screen,
  powerMonitor,
  safeStorage,
  dialog,
  shell,
  clipboard,
  protocol,
  net,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const { TaskRepository, atomicWrite } = require('./core/storage.cjs');
const { Config } = require('./core/config.cjs');
const { Themes } = require('./core/theme.cjs');
const { Credentials, testConnection } = require('./core/llm.cjs');
const { today, groups } = require('./core/tasks.cjs');
const geom = require('./windows/geometry.cjs');
const { performancePolicy } = require('./core/performance.cjs');
const testMode = process.argv.includes('--smoke-test');
const portableRoot = app.isPackaged
  ? path.dirname(process.execPath)
  : path.resolve(__dirname, '..');
const privatePaths = require('./core/private-root.cjs');
const defaultPrivateRoot =
  testMode && process.env.WS_TEST_DATA
    ? process.env.WS_TEST_DATA
    : privatePaths.resolvePrivateRoot(portableRoot);
const dataRoot = privatePaths.initialize(
  privatePaths.resolvePrivateRoot(
    portableRoot,
    testMode
      ? {
          WS_PRIVATE_ROOT:
            process.env.WS_TEST_DATA ||
            path.join(defaultPrivateRoot, 'validation', 'smoke-' + crypto.randomUUID()),
        }
      : { WS_PRIVATE_ROOT: defaultPrivateRoot },
  ),
);
try {
  for (const dir of [
    'config',
    'tasks',
    'themes',
    'backgrounds',
    'state',
    'backups',
    'cache',
    'logs',
  ])
    fs.mkdirSync(path.join(dataRoot, dir), { recursive: true });
  const probe = path.join(dataRoot, 'cache', '.write-test');
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
} catch {
  dialog.showErrorBox(
    'WS 无法写入便携目录',
    '请把整个 WS 文件夹移动到普通可写目录后重试。请检查 WS-Private 或选定的 PrivateRoot 是否可写；现有任务不会删除。',
  );
  app.exit(1);
}
app.setName('WS');
app.setAppUserModelId('WS.Desktop');
app.setPath('temp', path.join(dataRoot, 'temp'));
app.setPath('userData', path.join(dataRoot, 'cache', 'profile'));
app.setPath('sessionData', path.join(dataRoot, 'cache', 'session'));
app.setPath('logs', path.join(dataRoot, 'logs'));
app.setPath('crashDumps', path.join(dataRoot, 'cache', 'crashes'));
protocol.registerSchemesAsPrivileged([
  { scheme: 'wsapp', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  require('./core/private-transfer.cjs').recover(dataRoot);
  start();
}
function start() {
  let widget,
    manager,
    tray,
    repo,
    config,
    themes,
    integration,
    credentials,
    native,
    state = {},
    lastMode,
    desiredBounds,
    quitting = false,
    hidden = false,
    saveTimer,
    dragTimer,
    perfTimer,
    dateTimer,
    operationHideTimer,
    statusError = null,
    lastPerf = '';
  let testingLLM = false;
  let stopRecovery = () => {};
  const windows = () => [widget, manager].filter((w) => w && !w.isDestroyed());
  const broadcast = () => {
    windows().forEach((w) => w.webContents.send('changed'));
    clearTimeout(operationHideTimer);
    const finished = integration?.progress?.finishedAt;
    const remaining = finished ? finished + 5000 - Date.now() : 0;
    if (!integration?.running && remaining > 0)
      operationHideTimer = setTimeout(broadcast, remaining);
  };
  const log = (event) => {
    try {
      const file = path.join(dataRoot, 'logs', 'ws.log');
      if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024)
        fs.renameSync(file, file + '.previous');
      fs.appendFileSync(file, `${new Date().toISOString()} ${event}\n`);
    } catch {}
  };
  const safeError = (e) => String(e?.message || '操作失败').slice(0, 1000);
  const readState = () => {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(dataRoot, 'state', 'window.json'), 'utf8'),
      );
      if (
        parsed.version === 1 &&
        parsed.current &&
        ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(parsed.current[k]))
      )
        state = parsed;
    } catch {}
  };
  const toPhysical = (b) => {
    const p = screen.dipToScreenPoint({ x: b.x, y: b.y });
    const scale = screen.getDisplayMatching(b).scaleFactor;
    return { ...p, width: Math.round(b.width * scale), height: Math.round(b.height * scale) };
  };
  const bounds = () => {
    const r = native.rect(native.hwnd(widget));
    const p = screen.screenToDipPoint({ x: r.x, y: r.y });
    const scale = screen.getDisplayNearestPoint(p).scaleFactor;
    return {
      x: Math.round(p.x),
      y: Math.round(p.y),
      width: Math.round(r.width / scale),
      height: Math.round(r.height / scale),
    };
  };
  const setBounds = (b) => {
    desiredBounds = { ...b };
    native.setBounds(widget, toPhysical(b));
  };
  const saveState = () => {
    if (!widget || widget.isDestroyed()) return;
    try {
      const b = bounds();
      const d = screen.getDisplayMatching(b);
      const record = geom.remember(b, d);
      state = {
        ...state,
        version: 1,
        current: record,
        hidden,
        mode: config.value.mode,
        history: { ...(state.history || {}), [String(d.id)]: record },
      };
      atomicWrite(path.join(dataRoot, 'state', 'window.json'), JSON.stringify(state, null, 2));
    } catch {
      log('window_state_write_failed');
    }
  };
  const queueState = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 350);
  };
  function applyWindow(desired) {
    if (!widget || widget.isDestroyed()) return;
    const c = config.value;
    try {
      const b = desired || bounds();
      desiredBounds = { ...b };
      widget.setOpacity(c.appearance.windowOpacity);
      if (c.mode !== lastMode) {
        widget.setAlwaysOnTop(c.mode === 'topmost', 'floating');
        native.attach(widget, c.mode, toPhysical(b));
        lastMode = c.mode;
        setTimeout(() => {
          if (widget && !widget.isDestroyed()) {
            setBounds(desiredBounds);
            updatePerformance();
          }
        }, 120);
      } else if (desired) setBounds(desired);
      statusError = null;
    } catch (e) {
      statusError = '桌面层暂不可用：' + safeError(e) + '；可在设置中切换置顶模式。';
      log('desktop_attach_failed');
    }
    updatePerformance();
    broadcast();
  }
  function autostart() {
    if (!app.isPackaged || testMode) return;
    try {
      app.setLoginItemSettings({
        openAtLogin: config.value.autostart,
        name: 'WS',
        path: process.execPath,
        args: ['--autostart'],
      });
    } catch {
      statusError = '开机自启设置失败，请在程序设置中重试。';
      log('autostart_failed');
    }
  }
  function securedWindow(options) {
    const w = new BrowserWindow({
      ...options,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: true,
        devTools: !app.isPackaged,
      },
    });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('wsapp://app/')) e.preventDefault();
    });
    w.webContents.session.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    w.webContents.on('render-process-gone', () => {
      log('renderer_gone');
      if (!quitting) {
        if (w === widget) {
          w.destroy();
        } else w.reload();
      }
    });
    return w;
  }
  async function createWidget() {
    const b = geom.restore(state.current, screen.getAllDisplays(), screen.getPrimaryDisplay());
    if (!state.current) {
      b.width = Math.min(config.value.width, b.width);
      b.height = Math.min(config.value.height, b.height);
    }
    widget = securedWindow({
      ...b,
      title: 'WS · 今日',
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      show: false,
      hasShadow: false,
    });
    lastMode = null;
    lastPerf = '';
    desiredBounds = { ...b };
    widget.hookWindowMessage(0x02e0, () => {
      setTimeout(() => {
        if (widget && !widget.isDestroyed() && desiredBounds) setBounds(desiredBounds);
      }, 0);
    });
    widget.on('close', (e) => {
      if (!quitting) {
        e.preventDefault();
        hideWidget();
      }
    });
    widget.on('closed', () => {
      widget = null;
      if (!quitting) setTimeout(() => createWidget().catch(() => log('recreate_failed')), 1800);
    });
    await widget.loadURL('wsapp://app/widget.html');
    widget.showInactive();
    applyWindow(b);
    if (hidden) native.api.show(native.hwnd(widget), 0);
    widget.webContents.on('context-menu', (_e, params) => contextMenu(params));
  }
  function hideWidget() {
    hidden = true;
    if (widget && !widget.isDestroyed()) native.api.show(native.hwnd(widget), 0);
    updatePerformance();
    queueState();
    broadcast();
  }
  function showWidget() {
    hidden = false;
    if (widget && !widget.isDestroyed()) {
      const b = bounds();
      native.api.show(native.hwnd(widget), 4);
      applyWindow(b);
    } else createWidget();
    queueState();
    broadcast();
  }
  async function openManager(tab = 'tasks') {
    if (manager && !manager.isDestroyed()) {
      manager.show();
      manager.focus();
      manager.webContents.send('changed');
      await manager.webContents.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('ws-tab',{detail:${JSON.stringify(tab)}}))`,
      );
      return;
    }
    manager = securedWindow({
      width: 1020,
      height: 780,
      minWidth: 720,
      minHeight: 540,
      title: 'WS · 管理空间',
      backgroundColor: '#101c18',
      autoHideMenuBar: true,
      show: false,
    });
    manager.on('closed', () => {
      manager = null;
    });
    await manager.loadURL('wsapp://app/manager.html#' + encodeURIComponent(tab));
    manager.show();
  }
  function quit() {
    quitting = true;
    stopRecovery();
    saveState();
    clearInterval(perfTimer);
    clearInterval(dateTimer);
    clearTimeout(operationHideTimer);
    clearInterval(dragTimer);
    clearTimeout(saveTimer);
    repo?.close();
    config?.close();
    themes?.close();
    tray?.destroy();
    app.quit();
  }
  function contextMenu(params = {}) {
    Menu.buildFromTemplate([
      { label: '新增待办', click: () => openManager('new') },
      { label: '编辑待办 / 全部任务', click: () => openManager('tasks') },
      { type: 'separator' },
      {
        label: '桌面小组件',
        type: 'radio',
        checked: config.value.mode === 'desktop',
        click: () => setMode('desktop'),
      },
      {
        label: '始终置顶',
        type: 'radio',
        checked: config.value.mode === 'topmost',
        click: () => setMode('topmost'),
      },
      { label: '外观设置', click: () => openManager('appearance') },
      {
        label: '更换背景…',
        click: () =>
          importBackground().catch((e) => dialog.showErrorBox('背景导入失败', safeError(e))),
      },
      { label: '打开主题目录', click: () => shell.openPath(themes.dir) },
      { label: '打开任务文件', click: () => shell.openPath(repo.file) },
      { label: '重新加载主题', click: broadcast },
      {
        label: '屏幕边缘吸附',
        type: 'checkbox',
        checked: config.value.snap,
        click: () => {
          const c = structuredClone(config.value);
          c.snap = !c.snap;
          config.save(c);
        },
      },
      {
        label: '恢复右下角位置',
        click: () => {
          setBounds(
            geom.defaultBounds(
              screen.getPrimaryDisplay().workArea,
              config.value.width,
              config.value.height,
            ),
          );
          saveState();
        },
      },
      { label: 'LLM API 设置', click: () => openManager('llm') },
      { label: '程序设置', click: () => openManager('program') },
      { type: 'separator' },
      { label: hidden ? '重新显示' : '收起到托盘', click: hidden ? showWidget : hideWidget },
      { label: '退出 WS', click: quit },
    ]).popup({ window: widget });
  }
  function setMode(mode) {
    const c = structuredClone(config.value);
    c.mode = mode;
    config.save(c);
    saveState();
  }
  function beginDrag(kind) {
    if (!/^(move|n|s|e|w|ne|nw|se|sw)$/.test(kind)) throw new Error('无效窗口操作');
    clearInterval(dragTimer);
    const origin = screen.getCursorScreenPoint(),
      b = bounds();
    dragTimer = setInterval(() => {
      try {
        if (!(native.api.key(1) & 0x8000)) {
          clearInterval(dragTimer);
          const area = screen.getDisplayMatching(bounds()).workArea;
          setBounds(
            geom.clampBounds(config.value.snap ? geom.snapBounds(bounds(), area) : bounds(), area),
          );
          saveState();
          return;
        }
        const p = screen.getCursorScreenPoint(),
          dx = p.x - origin.x,
          dy = p.y - origin.y;
        let n = { ...b };
        if (kind === 'move') {
          n.x += dx;
          n.y += dy;
        } else {
          if (kind.includes('e')) n.width = Math.max(300, Math.min(1600, b.width + dx));
          if (kind.includes('s')) n.height = Math.max(300, Math.min(1600, b.height + dy));
          if (kind.includes('w')) {
            n.width = Math.max(300, Math.min(1600, b.width - dx));
            n.x = b.x + b.width - n.width;
          }
          if (kind.includes('n')) {
            n.height = Math.max(300, Math.min(1600, b.height - dy));
            n.y = b.y + b.height - n.height;
          }
        }
        setBounds(n);
      } catch {
        clearInterval(dragTimer);
      }
    }, 16);
  }
  async function importBackground() {
    const result = await dialog.showOpenDialog(manager || widget, {
      title: '选择背景（导入便携数据目录）',
      properties: ['openFile'],
      filters: [{ name: '图片 / 动画', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'apng'] }],
    });
    if (result.canceled) return null;
    const from = result.filePaths[0];
    if (fs.statSync(from).size > 25 * 1024 * 1024) throw new Error('图片大小不能超过 25MB');
    const ext = path.extname(from).toLowerCase();
    if (!/^\.(png|jpe?g|webp|gif|apng)$/.test(ext)) throw new Error('不支持此图片格式');
    const name = crypto.randomUUID() + ext;
    fs.copyFileSync(from, path.join(dataRoot, 'backgrounds', name));
    const c = structuredClone(config.value);
    c.appearance.background = name;
    config.save(c);
    return name;
  }
  function trusted(event, managerOnly = false) {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (
      !windows().includes(w) ||
      event.senderFrame !== event.sender.mainFrame ||
      !event.senderFrame.url.startsWith('wsapp://app/')
    )
      throw new Error('拒绝不可信窗口请求');
    if (managerOnly && w !== manager) throw new Error('请在管理窗口执行此操作');
    return w;
  }
  function handle(channel, fn, managerOnly = false) {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        const w = trusted(event, managerOnly);
        return { ok: true, value: await fn(w, ...args) };
      } catch (e) {
        return { ok: false, error: safeError(e) };
      }
    });
  }
  function snapshot() {
    return {
      ...repo.snapshot(),
      views: groups(repo.doc, today()),
      config: config.value,
      configError: config.error,
      statusError,
      hasKey: credentials.has(),
      integration: integration?.snapshot() || null,
      themes: themes.list(),
      day: today(),
      version: app.getVersion(),
      packaged: app.isPackaged,
      privateRoot: dataRoot,
      hidden,
      displays: screen.getAllDisplays().map((d) => ({
        id: String(d.id),
        label: d.label,
        workArea: d.workArea,
        scaleFactor: d.scaleFactor,
      })),
      bounds: widget && !widget.isDestroyed() ? bounds() : null,
      autostartRegistered: app.isPackaged
        ? app.getLoginItemSettings({ path: process.execPath, args: ['--autostart'] }).openAtLogin
        : false,
    };
  }
  app.on('second-instance', () => showWidget());
  app.on('window-all-closed', (e) => e?.preventDefault());
  app.on('before-quit', () => {
    quitting = true;
  });
  app
    .whenReady()
    .then(async () => {
      native = require('./windows/desktop.cjs');
      readState();
      repo = new TaskRepository(dataRoot);
      // WeChatTasks local API v1
      if (!testMode) {
        try {
          const stopTaskApi = require('./core/task-api.cjs').startTaskApi({ repo, dataRoot, log });
          app.on('before-quit', stopTaskApi);
        } catch {
          log('task_api_failed');
        }
      }
      config = new Config(dataRoot);
      themes = new Themes(dataRoot, path.join(__dirname, '..', 'defaults', 'theme'));
      credentials = new Credentials(dataRoot, safeStorage);
      integration = new (require('./core/integration.cjs').Integration)({
        root: portableRoot,
        dataRoot,
        repo,
        config,
        credentials,
        disabled: testMode,
      });
      integration.on('change', broadcast);
      app.on('before-quit', () => integration.close());
      protocol.handle('wsapp', (request) => {
        try {
          const url = new URL(request.url);
          let file;
          const route = decodeURIComponent(url.pathname).replace(/^\//, '');
          if (url.hostname !== 'app' || route.includes('..') || route.includes('\\'))
            return new Response('Forbidden', { status: 403 });
          if (route === 'vendor/purify.js') file = require.resolve('dompurify/dist/purify.js');
          else if (/^backgrounds\/[\w-]+\.(png|jpe?g|webp|gif|apng)$/i.test(route))
            file = path.join(dataRoot, route);
          else if (/^[\w-]+\.(html|js|css)$/.test(route))
            file = path.join(__dirname, 'renderer', route);
          else return new Response('Not found', { status: 404 });
          return net.fetch(pathToFileURL(file).href);
        } catch {
          return new Response('Not found', { status: 404 });
        }
      });
      handle('snapshot', () => snapshot());
      handle(
        'integration',
        async (_w, command, payload) => {
          if (command === 'copy_qq_login_token') {
            clipboard.writeText(integration.qq.loginToken());
            return { copied: true, reason: 'QQ 登录 Token 已复制，请在本机登录页粘贴' };
          }
          if (command === 'open_mcp_folder') {
            const folder = path.join(dataRoot, 'config', 'mcp');
            fs.mkdirSync(folder, { recursive: true });
            const note = path.join(folder, 'README.txt');
            if (!fs.existsSync(note))
              fs.writeFileSync(
                note,
                'WS MCP 配置\nserver.json 控制独立只读 MCP 服务。工作台不依赖 MCP 开关。\n启动：runtime/ws-worker/ws-worker.exe --mcp --data <同一 PrivateRoot 的绝对路径>\n凭据由同一 PrivateRoot 管理，不要写入命令行。跨电脑后按连接提示重新登录。\n打开此目录不会启动 MCP 或改写已有配置。\n',
              );
            const error = await shell.openPath(folder);
            if (error) throw new Error('无法打开 MCP 配置目录：' + error);
            return { opened: true };
          }
          if (command === 'prepare_qq') {
            const chosen = await dialog.showOpenDialog(manager, {
              title: '选择已安装的官方 QQ.exe（仅复制到 WS 专用目录）',
              properties: ['openFile'],
              filters: [{ name: 'QQ 程序', extensions: ['exe'] }],
            });
            if (chosen.canceled) return null;
            payload = { path: chosen.filePaths[0] };
          }
          if (['open_qq_login', 'switch_qq_account', 'restart_qq'].includes(command)) {
            await integration.action(command === 'open_qq_login' ? 'start_qq' : command, payload);
            await integration.qq.waitForLoginPage();
            await shell.openExternal(integration.qq.loginUrl());
            return {
              opened: true,
              reason:
                command === 'switch_qq_account'
                  ? '请登录新账号，再确认当前账号并连接'
                  : '已携带 Token 打开 QQ 登录；如仍要求输入，可点击复制登录 Token',
            };
          }
          if (command === 'import_keys') {
            const chosen = await dialog.showOpenDialog(manager, {
              title: '导入本人授权的数据库密钥（可为 DPAPI 或上游 JSON）',
              properties: ['openFile'],
              filters: [{ name: '密钥文件', extensions: ['json', 'dpapi'] }],
            });
            if (chosen.canceled) return null;
            payload = { source_id: payload?.source_id, path: chosen.filePaths[0] };
          }
          if (command === 'import_feishu') {
            const chosen = await dialog.showOpenDialog(manager, {
              title: '选择已有飞书连接器目录（包含 server/.env）',
              properties: ['openDirectory'],
            });
            if (chosen.canceled) return null;
            payload = { source_id: payload?.source_id, path: chosen.filePaths[0] };
          }
          return integration.action(command, payload);
        },
        true,
      );
      handle(
        'private-data',
        async (_w, command, payload = {}) => {
          if (integration.running) throw new Error('请等待采集结束后再迁移');
          const transfer = require('./core/private-transfer.cjs');
          if (command === 'choose-directory') {
            const chosen = await dialog.showOpenDialog(manager, {
              title: '选择本机数据目录',
              properties: ['openDirectory'],
            });
            return chosen.canceled ? null : chosen.filePaths[0];
          }
          if (command === 'export') {
            const result = transfer.exportPrivate(dataRoot, payload.selection);
            await shell.openPath(result.directory);
            return result;
          }
          if (command === 'import') {
            if ((integration.info?.messages || 0) > 0)
              throw new Error('目标已有消息历史，请先选择新的空 PrivateRoot');
            const chosen = await dialog.showOpenDialog(manager, {
              title: '选择 WS-PRIVATE-MIGRATION 文件夹',
              properties: ['openDirectory'],
            });
            if (chosen.canceled) return null;
            await integration.worker({ command: 'validate_transfer', path: chosen.filePaths[0] });
            integration.close();
            try {
              const result = transfer.importPrivate(dataRoot, chosen.filePaths[0]);
              app.relaunch();
              app.quit();
              return result;
            } catch (e) {
              app.relaunch();
              app.quit();
              throw e;
            }
          }
          if (command === 'relocate') {
            const chosen = await dialog.showOpenDialog(manager, {
              title: '选择私密数据的父文件夹（将创建 WS-Private）',
              properties: ['openDirectory', 'createDirectory'],
            });
            if (chosen.canceled) return null;
            const target = path.join(chosen.filePaths[0], 'WS-Private');
            if (fs.existsSync(target))
              throw new Error('目标 WS-Private 已存在，请选择其他父目录；已有数据未改动');
            const relative = path.relative(dataRoot, target);
            if (!relative.startsWith('..') && !path.isAbsolute(relative))
              throw new Error('新目录不能位于当前 PrivateRoot 内');
            const link = path.join(portableRoot, 'WS-Private');
            // A custom environment binding must be updated by its owner.
            if (fs.realpathSync(link) !== dataRoot)
              throw new Error('当前使用环境绑定，请通过启动环境更换 PrivateRoot');
            const job = path.join(dataRoot, 'state', 'relocation-job.json');
            atomicWrite(
              job,
              JSON.stringify({
                pid: process.pid,
                source: dataRoot,
                target,
                link,
                empty: payload.empty === true,
                executable: process.execPath,
                args: app.isPackaged ? [] : [app.getAppPath()],
              }),
            );
            const child = require('node:child_process').spawn(
              process.execPath,
              [path.join(__dirname, 'core', 'relocate.cjs'), job],
              {
                env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
              },
            );
            child.unref();
            app.quit();
            return { restart: true };
          }
          throw new Error('未知私密数据操作');
        },
        true,
      );
      handle('task', (_w, action, rev) => repo.apply(action, rev));
      handle('theme', () => themes.read(config.value.theme));
      handle(
        'save-config',
        async (_w, c) => {
          const old = config.value;
          if (old.llm.baseUrl !== c.llm.baseUrl) {
            if (integration.running) throw new Error('请等待当前分析结束后更换 AI 服务');
          }
          config.save(c);
          if (
            widget &&
            !widget.isDestroyed() &&
            (old.width !== c.width || old.height !== c.height)
          ) {
            const b = bounds();
            setBounds(
              geom.clampBounds(
                { ...b, width: c.width, height: c.height },
                screen.getDisplayMatching(b).workArea,
              ),
            );
            saveState();
          }
          return config.value;
        },
        true,
      );
      handle(
        'credential',
        (_w, key) => {
          credentials.set(key);
          broadcast();
          return credentials.has();
        },
        true,
      );
      handle(
        'test-llm',
        async () => {
          if (testingLLM) throw new Error('已有测试请求进行中');
          testingLLM = true;
          try {
            return await testConnection(config.value.llm, credentials.get(), (url, options) =>
              net.fetch(url, options),
            );
          } finally {
            testingLLM = false;
          }
        },
        true,
      );
      handle('window-action', async (w, action, payload) => {
        if (action === 'toggle-date') {
          config.reload();
          const next = structuredClone(config.value);
          next.appearance.dateCollapsed = !next.appearance.dateCollapsed;
          config.save(next);
          return { collapsed: next.appearance.dateCollapsed };
        }
        if (action === 'manager') {
          await openManager(
            [
              'tasks',
              'new',
              'appearance',
              'window',
              'llm',
              'messages',
              'summary',
              'program',
            ].includes(payload)
              ? payload
              : 'tasks',
          );
          return;
        }
        if (action === 'hide') {
          hideWidget();
          return;
        }
        if (action === 'show') {
          showWidget();
          return;
        }
        if (action === 'menu') {
          contextMenu();
          return;
        }
        if (action === 'drag') {
          if (w !== widget) throw new Error('窗口不匹配');
          beginDrag(payload);
          return;
        }
        if (action === 'quit') {
          quit();
          return;
        }
        if (action === 'open-theme')
          return shell.openPath(path.join(themes.dir, config.value.theme));
        if (action === 'open-tasks') return shell.openPath(repo.file);
        if (action === 'reload-theme') {
          broadcast();
          return;
        }
        if (w !== manager) throw new Error('请在管理窗口执行此操作');
        if (action === 'import-background') return importBackground();
        if (action === 'reset-position') {
          setBounds(
            geom.defaultBounds(
              screen.getPrimaryDisplay().workArea,
              config.value.width,
              config.value.height,
            ),
          );
          saveState();
          return;
        }
        if (action === 'move-display') {
          const d = screen.getAllDisplays().find((x) => String(x.id) === payload);
          if (!d) throw new Error('显示器已断开');
          const record = state.history?.[payload];
          setBounds(
            record
              ? geom.restore(record, [d], d)
              : geom.defaultBounds(d.workArea, bounds().width, bounds().height),
          );
          saveState();
          return;
        }
        if (action === 'open-data') return shell.openPath(dataRoot);
        if (action === 'backup-list')
          return fs
            .readdirSync(path.join(dataRoot, 'backups'))
            .filter((f) => f.startsWith('tasks.json.'))
            .sort()
            .reverse();
        if (action === 'restore-backup') {
          repo.restore(payload);
          return;
        }
        throw new Error('不支持的操作');
      });
      repo.on('change', broadcast);
      themes.on('change', broadcast);
      config.on('change', () => {
        applyWindow();
        autostart();
      });
      await createWidget();
      autostart();
      if (!testMode || process.argv.includes('--recovery-test')) {
        stopRecovery = require('./windows/recovery.cjs').startRecovery({
          dataRoot,
          executable: process.execPath,
          args: app.isPackaged
            ? process.argv.slice(1)
            : [app.getAppPath(), ...process.argv.slice(2)],
        });
      }
      const trayFile = path.join(__dirname, '..', 'assets', 'tray.png');
      tray = new Tray(nativeImage.createFromPath(trayFile));
      tray.setToolTip('WS · 桌面待办');
      tray.on('double-click', showWidget);
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: '显示 WS', click: showWidget },
          { label: '管理待办 / 设置', click: () => openManager() },
          { label: '收起 WS', click: hideWidget },
          { type: 'separator' },
          { label: '退出 WS', click: quit },
        ]),
      );
      const topology = () => {
        if (!widget || widget.isDestroyed()) return;
        const displays = screen.getAllDisplays();
        const current = bounds();
        const preferred = state.current;
        const d = displays.find((v) => String(v.id) === preferred?.displayId);
        setBounds(
          d
            ? geom.restore(preferred, displays, screen.getPrimaryDisplay())
            : geom.clampBounds(current, screen.getPrimaryDisplay().workArea),
        );
        broadcast();
      };
      screen.on('display-added', topology);
      screen.on('display-removed', topology);
      screen.on('display-metrics-changed', topology);
      let day = today();
      dateTimer = setInterval(() => {
        if (day !== today()) {
          day = today();
          broadcast();
        }
      }, 15000);
      perfTimer = setInterval(() => {
        try {
          if (!widget || widget.isDestroyed()) return;
          if (!native.api.valid(native.hwnd(widget))) {
            widget.destroy();
            return;
          }
          if (config.value.mode === 'desktop' && !native.api.parent(native.hwnd(widget))) {
            lastMode = null;
            applyWindow(desiredBounds);
          }
          updatePerformance();
        } catch {
          log('performance_probe_failed');
        }
      }, 2000);
      powerMonitor.on('on-ac', updatePerformance);
      powerMonitor.on('on-battery', updatePerformance);
      powerMonitor.on('lock-screen', updatePerformance);
      powerMonitor.on('unlock-screen', updatePerformance);
      log('startup_ok');
      if (process.argv.includes('--verify-message-import')) {
        await require('../test/live-import.cjs')({
          widget,
          openManager,
          repo,
          dataRoot,
          integration,
        });
      }
      if (testMode) {
        await require(
          process.argv.includes('--optimizations-053-test')
            ? '../test/optimizations-053.cjs'
            : process.argv.includes('--optimizations-test')
              ? '../test/optimizations-052.cjs'
              : process.argv.includes('--qq-controls-test')
                ? '../test/qq-controls.cjs'
                : process.argv.includes('--flow-acceptance')
                  ? '../test/flow-040.cjs'
                  : process.argv.includes('--interactive-test')
                    ? '../test/interactive.cjs'
                    : process.argv.includes('--lifecycle-test')
                      ? '../test/lifecycle.cjs'
                      : process.argv.includes('--resource-test')
                        ? '../test/resources.cjs'
                        : '../test/smoke.cjs',
        )({
          app,
          get widget() {
            return widget;
          },
          openManager,
          showWidget,
          hideWidget,
          repo,
          config,
          credentials,
          themes,
          native,
          dataRoot,
          integration,
          snapshot,
          bounds,
          setBounds,
          broadcast,
          quit,
        });
      }
    })
    .catch((e) => {
      log('startup_failed');
      dialog.showErrorBox('WS 启动失败', safeError(e));
      app.exit(1);
    });
  process.on('uncaughtException', () => {
    log('uncaught_exception');
    statusError = '程序遇到异常，未自动覆盖数据；请从托盘退出后重启。';
    broadcast();
  });
  function updatePerformance() {
    try {
      if (!widget || widget.isDestroyed() || !native || !config) return;
      const c = config.value.appearance;
      const p = performancePolicy({
        hidden,
        covered: !hidden && native.occluded(widget),
        battery: powerMonitor.isOnBatteryPower(),
        locked: powerMonitor.getSystemIdleState(300) === 'locked',
        animations: c.animations,
        mode: c.performance,
        fps: c.fps,
      });
      const json = JSON.stringify(p);
      if (json !== lastPerf) {
        lastPerf = json;
        widget.webContents.send('performance', p);
      }
    } catch {
      log('performance_probe_failed');
    }
  }
}
