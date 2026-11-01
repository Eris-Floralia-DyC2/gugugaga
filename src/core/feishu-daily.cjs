const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { atomicWrite } = require('./storage.cjs');

function scheduleTarget(now, time) {
  const day = new Date(now);
  const clock = `${String(day.getHours()).padStart(2, '0')}:${String(day.getMinutes()).padStart(2, '0')}`;
  if (clock < time) day.setDate(day.getDate() - 1);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

class FeishuDaily {
  constructor(integration) {
    this.integration = integration;
    this.nextRetry = 0;
  }
  config() {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(this.integration.dataRoot, 'config/feishu-daily.json'), 'utf8'),
      );
    } catch {
      return null;
    }
  }
  async tick(now) {
    const owner = this.integration,
      c = this.config();
    if (
      owner.disabled ||
      owner.running ||
      Date.now() < this.nextRetry ||
      !c?.enabled ||
      !c.source ||
      !c.groups.length
    )
      return;
    const target = scheduleTarget(now, c.daily_time);
    if (!c.groups.some((g) => g.start_date <= target)) return;
    const stamp = crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex');
    const file = path.join(owner.dataRoot, 'state/feishu-daily-schedule.json');
    let previous;
    try {
      previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    if (previous?.stamp === stamp && previous.day >= target) return;
    try {
      const result = await this.action('feishu_daily_run', { scheduled: true });
      if (!result.ok)
        throw new Error(
          result.results
            .filter((r) => r.status === 'failed')
            .map((r) => r.reason)
            .join('；'),
        );
      atomicWrite(file, JSON.stringify({ day: target, stamp, finished: Date.now() }));
    } catch (e) {
      owner.error = '飞书群聊总结：' + e.message;
      this.nextRetry = Date.now() + 300000;
      owner.emit('change');
    }
  }
  async authorize() {
    if (this.server)
      return {
        authorization_pending: true,
        reason: '请完成已打开的飞书授权页面',
      };
    const owner = this.integration,
      nonce = crypto.randomBytes(32).toString('base64url');
    const details = await owner.worker({
      command: 'feishu_daily_auth_url',
      nonce,
    });
    const redirect = new URL(details.redirect_uri);
    if (
      redirect.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost'].includes(redirect.hostname) ||
      !redirect.port ||
      redirect.pathname !== '/oauth/callback'
    )
      throw new Error('请在飞书应用后台配置本机回调 http://127.0.0.1:8001/oauth/callback');
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const received = Buffer.from(url.searchParams.get('state') || '');
      const expected = Buffer.from(nonce);
      const valid =
        received.length === expected.length && crypto.timingSafeEqual(received, expected);
      if (req.method !== 'GET' || url.pathname !== redirect.pathname || !valid) {
        res.writeHead(400);
        res.end('Invalid OAuth callback');
        return;
      }
      const code = url.searchParams.get('code');
      if (!code || code.length > 2048 || this.exchanging) {
        res.writeHead(400);
        res.end('Authorization was not completed');
        return;
      }
      this.exchanging = true;
      try {
        const result = await owner.operation('检测连接', () =>
          owner.worker({ command: 'feishu_daily_exchange', code }),
        );
        if (!result.connected) throw new Error(result.reason || '授权未完成');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'none'",
        });
        res.end(
          '<meta charset="utf-8"><h1>飞书连接成功</h1><p>请返回 WS 选择群聊和总结时间。此页面可以关闭。</p>',
        );
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('飞书授权未完成，请返回 WS 查看连接状态并重试。');
      } finally {
        this.close();
        owner.emit('change');
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', () =>
        reject(new Error('本机飞书授权端口被占用，请关闭其他飞书授权服务后重试')),
      );
      server.listen(Number(redirect.port), '127.0.0.1', resolve);
    });
    this.server = server;
    this.authTimer = setTimeout(() => this.close(), 600000);
    this.authTimer.unref?.();
    try {
      await require('electron').shell.openExternal(details.url);
    } catch (e) {
      this.close();
      throw e;
    }
    return {
      authorization_pending: true,
      reason: '已打开飞书登录页，请完成授权后返回 WS',
    };
  }
  async action(command, payload = {}) {
    const owner = this.integration;
    const allowed = [
      'feishu_daily_status',
      'feishu_daily_save',
      'feishu_daily_connect',
      'feishu_daily_groups',
      'feishu_daily_test',
      'feishu_daily_run',
      'feishu_daily_configure',
    ];
    if (!allowed.includes(command)) throw new Error('不支持的飞书操作');
    if (command === 'feishu_daily_status') return owner.worker({ command, offset: payload.offset });
    if (command === 'feishu_daily_run')
      return owner.operation('采集消息', () =>
        owner.worker(
          {
            command,
            scheduled: payload.scheduled === true,
            llm: { ...owner.config.value.llm, key: owner.credentials.get() },
          },
          900000,
        ),
      );
    const result = await owner.operation(
      command === 'feishu_daily_save' ? '保存设置' : '检测连接',
      () => owner.worker({ ...payload, command }, 240000),
    );
    if (command === 'feishu_daily_connect' && !result.connected) return this.authorize();
    if (command === 'feishu_daily_save') this.nextRetry = 0;
    return result;
  }
  close() {
    clearTimeout(this.authTimer);
    this.server?.close();
    this.server = null;
    this.exchanging = false;
  }
}
module.exports = { FeishuDaily, scheduleTarget };
