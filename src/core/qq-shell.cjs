const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');
const { atomicWrite } = require('./storage.cjs');
const http = require('node:http');
const crypto = require('node:crypto');
const read = (file, fallback = {}) =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : fallback;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function localRequest(port, route, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: route,
        method: raw ? 'POST' : 'GET',
        headers: {
          ...headers,
          ...(raw
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 1024 * 1024) req.destroy(new Error('本机响应过大'));
          else chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode,
              value: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          } catch {
            reject(new Error('本机接口返回格式无效'));
          }
        });
      },
    );
    req.setTimeout(2000, () => req.destroy(new Error('本机接口连接超时')));
    req.on('error', reject);
    req.end(raw);
  });
}

// Never kill by process name or port owner. Exact private executable paths only;
// recheck each PID immediately before stopping to avoid stopping an unrelated QQ.
async function processControl(base, stop = false) {
  const targets = ['client/QQ.exe', 'shell/NapCatWinBootMain.exe', 'shell/qce-server.exe'].map(
    (f) => path.resolve(base, f),
  );
  const script = String.raw`$ErrorActionPreference='Stop'
$targets=@((ConvertFrom-Json $env:WS_QQ_OWNED_EXECUTABLES) | ForEach-Object {[string]$_})
$rows=@(Get-CimInstance Win32_Process -Filter "Name='QQ.exe' OR Name='NapCatWinBootMain.exe' OR Name='qce-server.exe'" | Where-Object {$_.ExecutablePath -and $targets -icontains [IO.Path]::GetFullPath($_.ExecutablePath)})
if($env:WS_QQ_STOP_OWNED -eq '1'){
 foreach($row in ($rows | Sort-Object @{Expression={if($_.Name -eq 'NapCatWinBootMain.exe'){0}else{1}}})){
  $current=Get-CimInstance Win32_Process -Filter ("ProcessId="+[int]$row.ProcessId)
  if($current -and $current.ExecutablePath -and $targets -icontains [IO.Path]::GetFullPath($current.ExecutablePath)){
   Stop-Process -Id $current.ProcessId -Force -ErrorAction SilentlyContinue
  }
 }
}
ConvertTo-Json -InputObject @($rows | ForEach-Object {[pscustomobject]@{pid=[int]$_.ProcessId;name=$_.Name}}) -Compress`;
  const { stdout } = await promisify(execFile)(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        WS_QQ_OWNED_EXECUTABLES: JSON.stringify(targets),
        WS_QQ_STOP_OWNED: stop ? '1' : '0',
      },
    },
  );
  return JSON.parse(stdout.trim() || '[]');
}

class QQShell {
  constructor(dataRoot, hooks = {}) {
    this.base = path.join(dataRoot, 'qq');
    this.stateFile = path.join(dataRoot, 'state/qq-session.json');
    this.child = null;
    this.starting = null;
    this.request = hooks.request || localRequest;
    this.processes = hooks.processes || ((stop) => processControl(this.base, stop));
    this.launch = hooks.launch || spawn;
  }
  session() {
    return read(this.stateFile, { version: 1, paused: false, switching: false });
  }
  isPaused() {
    const s = this.session();
    return s.paused === true || s.switching === true;
  }
  setSession(next) {
    atomicWrite(
      this.stateFile,
      JSON.stringify({ ...this.session(), ...next, version: 1, changedAt: Date.now() }),
    );
  }
  async webStatus() {
    const web = read(path.join(this.base, 'shell/config/webui.json'));
    if (!web.token) return null;
    const hash = crypto
      .createHash('sha256')
      .update(web.token + '.napcat')
      .digest('hex');
    const login = await this.request(6099, '/api/auth/login', {}, { hash });
    const credential = login.value.data?.Credential;
    if (!credential) return { state: 'token_invalid' };
    const r = await this.request(
      6099,
      '/api/QQLogin/CheckLoginStatus',
      { Authorization: 'Bearer ' + credential },
      {},
    );
    return r.value.data || { state: 'unavailable' };
  }
  async status({ ignorePause = false } = {}) {
    const session = this.session();
    if (!fs.existsSync(path.join(this.base, 'installation.json')))
      return { state: 'unprepared', paused: this.isPaused(), reason: '尚未准备 QQ 环境' };
    const own = await this.processes(false);
    if (!ignorePause && this.isPaused() && !own.length)
      return {
        state: session.switching ? 'switching' : 'stopped',
        paused: true,
        processCount: 0,
        reason: session.switching
          ? '正在切换账号，请启动 QQ 登录并确认新账号'
          : 'QQ 后台已退出，QQ 自动采集已暂停；点击启动后恢复',
      };
    let apiPresent = false,
      apiStatus = 0;
    const security = read(path.join(this.base, 'profile/.qq-chat-exporter/security.json'));
    try {
      const r = await this.request(40653, '/api/system/info', {
        Authorization: 'Bearer ' + security.accessToken,
      });
      apiPresent = true;
      apiStatus = r.status;
      if (!own.length)
        return {
          state: 'port_conflict',
          paused: this.isPaused(),
          processCount: 0,
          reason: '本机端口被其他 QQ 环境占用，WS 不会结束其他程序',
        };
      const n = r.value.data?.napcat;
      if (r.status === 200 && r.value.success && n?.online && n.workingEnv === 'shell')
        return {
          state: session.switching ? 'switching' : 'ready',
          online: true,
          paused: this.isPaused(),
          accountId: n.selfInfo?.uin || '',
          accountName: n.selfInfo?.nick || '',
          processCount: own.length,
          reason: session.switching
            ? '新账号已登录，请确认当前账号并连接'
            : 'QQ 已登录，采集服务正常',
        };
    } catch {}
    let web;
    try {
      web = await this.webStatus();
    } catch {}
    if (web?.state === 'token_invalid' || apiStatus === 401 || apiStatus === 403)
      return {
        state: 'token_invalid',
        paused: this.isPaused(),
        processCount: own.length,
        reason: 'QQ 本机接口凭据不匹配，请重启 QQ 后台；网页退出登录不等于退出 QQ',
      };
    if (web && !web.isLogin && !web.loginError && !web.state)
      return {
        state: session.switching ? 'switching' : 'needs_login',
        paused: this.isPaused(),
        processCount: own.length,
        reason: 'QQ 后台已启动，等待本人扫码或安全验证',
      };
    if (web?.loginError)
      return {
        state: 'login_error',
        paused: this.isPaused(),
        processCount: own.length,
        reason: /已登录|重复/.test(web.loginError)
          ? 'QQ 提示账号已登录，可能有重复实例；请重启 QQ 后台'
          : 'QQ 登录未完成，请打开 QQ 登录页查看并完成验证',
      };
    if (web?.isLogin && web.loginPhase === 'initializing')
      return {
        state: 'starting',
        paused: this.isPaused(),
        processCount: own.length,
        reason: 'QQ 已登录，采集服务正在初始化，请稍后刷新状态',
      };
    if (own.length)
      return {
        state: 'unavailable',
        paused: this.isPaused(),
        processCount: own.length,
        reason: 'QQ 进程仍在，但采集服务未就绪；请点击重启 QQ 后台，不必反复扫码',
      };
    if (apiPresent || web)
      return {
        state: 'port_conflict',
        paused: this.isPaused(),
        processCount: 0,
        reason: '本机端口被其他 QQ 环境占用，WS 不会结束其他程序',
      };
    return {
      state: 'not_running',
      paused: this.isPaused(),
      processCount: 0,
      reason: 'QQ 采集后台未运行，请点击启动 QQ 后台',
    };
  }
  async stop(reason = 'user') {
    this.setSession({ paused: true, switching: reason === 'switching', reason });
    await this.processes(true);
    for (let i = 0; i < 12; i++) {
      if (!(await this.processes(false)).length) {
        this.child = null;
        return {
          stopped: true,
          paused: true,
          reason: 'QQ 后台已退出；已保存的登录资料、消息和任务保留',
        };
      }
      await sleep(250);
    }
    throw new Error('部分 WS 专用 QQ 进程未能退出，自动采集已暂停，请重试退出；未结束日常 QQ');
  }
  async start(options = {}) {
    if (this.starting) return this.starting;
    if (this.isPaused() && !options.explicit)
      throw new Error('QQ 后台已暂停，请先点击启动 QQ 后台');
    this.starting = this.startOnce(options).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  async startOnce({ explicit = false, forceLogin = false, forSwitch = false } = {}) {
    const file = path.join(this.base, 'installation.json');
    const installed = read(file);
    installed.qq_exe = path.join(this.base, 'client/QQ.exe');
    if (installed.version !== '6.3.2' || !fs.existsSync(installed.qq_exe))
      throw new Error('请先在数据源设置中准备有效的 QQ 专用环境');
    const lock = path.join(this.base, 'start.lock');
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      let alive = false;
      try {
        if (Number.isInteger(pid) && pid > 0) {
          process.kill(pid, 0);
          alive = true;
        }
      } catch {}
      if (alive) throw new Error('另一个 WS 正在启动 QQ，请稍后刷新状态');
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
    }
    try {
      const current = await this.status({ ignorePause: true });
      if (current.processCount || current.online) {
        if (['ready', 'needs_login', 'switching', 'starting'].includes(current.state)) {
          if (explicit)
            this.setSession({
              paused: forSwitch,
              switching: forSwitch,
              reason: forSwitch ? 'switching' : '',
            });
          return current;
        }
        throw new Error(current.reason);
      }
      if (current.state === 'port_conflict' || current.state === 'token_invalid')
        throw new Error(current.reason);
      if (explicit)
        this.setSession({
          paused: forSwitch,
          switching: forSwitch,
          reason: forSwitch ? 'switching' : '',
        });
      const runtime = path.join(this.base, 'shell'),
        profile = path.join(this.base, 'profile');
      const resourceDir = path.resolve(
        this.base,
        'client',
        installed.resource_relative || 'resources/app',
      );
      if (!resourceDir.startsWith(path.join(this.base, 'client') + path.sep))
        throw new Error('QQ 资源目录无效');
      if (forceLogin) {
        const webFile = path.join(runtime, 'config/webui.json');
        const web = read(webFile);
        atomicWrite(webFile, JSON.stringify({ ...web, autoLoginAccount: '' }));
      }
      const loader =
        '(async () => {await import(' +
        JSON.stringify(pathToFileURL(path.join(runtime, 'napcat.mjs')).href) +
        ')})()';
      atomicWrite(path.join(runtime, 'loadNapCat.js'), loader);
      atomicWrite(path.join(resourceDir, 'loadNapCat.js'), loader);
      atomicWrite(file, JSON.stringify(installed));
      const env = {
        ...process.env,
        USERPROFILE: profile,
        HOME: profile,
        APPDATA: path.join(profile, 'AppData/Roaming'),
        LOCALAPPDATA: path.join(profile, 'AppData/Local'),
        NAPCAT_PATCH_PACKAGE: path.join(runtime, 'qqnt.json'),
        NAPCAT_LOAD_PATH: path.join(runtime, 'loadNapCat.js'),
        NAPCAT_INJECT_PATH: path.join(runtime, 'NapCatWinBootHook.dll'),
        NAPCAT_LAUNCHER_PATH: path.join(runtime, 'NapCatWinBootMain.exe'),
        NAPCAT_MAIN_PATH: path.join(runtime, 'napcat.mjs').replaceAll('\\', '/'),
        QCE_CONFIG_DIR: path.join(profile, '.qq-chat-exporter'),
        QCE_SERVER_PORT: '40653',
        QCE_NO_AUTO_OPEN: '1',
        QCE_LOG_DIR: path.join(this.base, 'logs'),
      };
      delete env.NAPCAT_QUICK_ACCOUNT;
      delete env.NAPCAT_QUICK_PASSWORD;
      delete env.NAPCAT_QUICK_PASSWORD_MD5;
      for (const dir of [env.APPDATA, env.LOCALAPPDATA, env.QCE_LOG_DIR])
        fs.mkdirSync(dir, { recursive: true });
      this.child = this.launch(
        path.join(runtime, 'NapCatWinBootMain.exe'),
        [installed.qq_exe, env.NAPCAT_INJECT_PATH],
        { cwd: runtime, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      this.child.stdout?.on('data', () => {});
      this.child.stderr?.on('data', () => {});
      this.child.on('error', () => {
        this.child = null;
      });
      return { started: true, reason: 'QQ 后台正在启动，请稍后刷新状态' };
    } finally {
      fs.unlinkSync(lock);
    }
  }
  async restart(options = {}) {
    await this.stop(options.forSwitch ? 'switching' : 'restart');
    return this.start({ ...options, explicit: true });
  }
  async waitForLoginPage() {
    for (let i = 0; i < 50; i++) {
      try {
        const r = await this.request(6099, '/api/test');
        if (r.status === 200) return;
      } catch {}
      await sleep(500);
    }
    throw new Error('QQ 授权页面尚未就绪，请稍后刷新状态或重启 QQ 后台');
  }
  loginToken() {
    let token;
    try {
      token = read(path.join(this.base, 'shell/config/webui.json')).token;
    } catch {
      throw new Error('QQ 登录配置暂时无法读取，请先准备 QQ 环境后重试');
    }
    if (typeof token !== 'string' || !token.trim() || token.length > 4096 || /[\r\n]/.test(token))
      throw new Error('QQ 登录 Token 尚未准备好，请先准备 QQ 环境后重试');
    return token;
  }
  loginUrl() {
    return 'http://127.0.0.1:6099/webui?token=' + encodeURIComponent(this.loginToken());
  }
}
module.exports = { QQShell, localRequest, processControl };
