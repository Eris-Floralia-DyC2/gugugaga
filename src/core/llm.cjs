const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('./storage.cjs');
class Credentials {
  constructor(root, safe) {
    this.file = path.join(root, 'config', 'credential.dpapi');
    this.safe = safe;
  }
  has() {
    return fs.existsSync(this.file);
  }
  set(key) {
    if (typeof key !== 'string' || key.length > 4096) throw new Error('密钥格式无效');
    if (!this.safe.isEncryptionAvailable()) throw new Error('Windows 凭据加密不可用，拒绝明文保存');
    if (!key) {
      if (this.has()) fs.unlinkSync(this.file);
      return;
    }
    atomicWrite(this.file, this.safe.encryptString(key).toString('base64'));
  }
  get() {
    if (!this.has()) return '';
    try {
      return this.safe.decryptString(Buffer.from(fs.readFileSync(this.file, 'utf8'), 'base64'));
    } catch {
      throw new Error('密钥无法在当前 Windows 账户解密，请重新输入');
    }
  }
}
function endpoint(base) {
  let u;
  try {
    u = new URL(base);
  } catch {
    throw new Error('Base URL 格式无效');
  }
  if (u.username || u.password || u.search || u.hash)
    throw new Error('Base URL 不能含凭据、查询参数或片段');
  if (
    u.protocol !== 'https:' &&
    !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
  )
    throw new Error('远程接口必须使用 HTTPS；本机接口可使用 HTTP');
  u.pathname = u.pathname.replace(/\/+$/, '');
  if (!u.pathname.endsWith('/chat/completions')) u.pathname += '/chat/completions';
  return u.href;
}
function classify(status, body) {
  const code = String(body?.error?.code || '');
  if (status === 401 || status === 403) return '密钥无效或权限不足';
  if (status === 429) return '请求限流或余额不足';
  if (status >= 500) return '服务端错误';
  if (status === 404 && /model/i.test(code)) return '模型不存在';
  if (/model.*(not|invalid)|model_not_found/i.test(code)) return '模型不存在';
  return '接口不兼容或参数错误';
}
async function testConnection(config, key, fetcher = fetch) {
  if (!config.model?.trim()) return { ok: false, kind: '配置错误', message: '请填写模型名称' };
  let url;
  try {
    url = endpoint(config.baseUrl);
  } catch (e) {
    return { ok: false, kind: '配置错误', message: e.message };
  }
  if (!key) return { ok: false, kind: '配置错误', message: '尚未保存 API Key' };
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeout * 1000);
  try {
    const response = await fetcher(url, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: 'Reply with OK only.' }],
        max_tokens: config.maxTokens,
        temperature: config.temperature,
        ...(config.thinking === 'disabled' ? { thinking: { type: 'disabled' } } : {}),
      }),
    });
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 256 * 1024) {
        await reader.cancel();
        return { ok: false, kind: '接口不兼容', message: '响应超过 256KB 限制' };
      }
      chunks.push(Buffer.from(value));
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return { ok: false, kind: '接口不兼容', message: '接口返回的不是 JSON' };
    }
    if (!response.ok)
      return {
        ok: false,
        kind: classify(response.status, body),
        message: `HTTP ${response.status}，请检查提供商、模型与账户状态`,
      };
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim())
      return { ok: false, kind: '接口不兼容', message: '未收到有效的推理文本' };
    // Never echo a provider's raw response: it may contain the submitted key.
    return {
      ok: true,
      kind: '推理成功',
      message: `已收到模型文本，耗时 ${Date.now() - start} ms`,
      durationMs: Date.now() - start,
    };
  } catch (e) {
    return {
      ok: false,
      kind: controller.signal.aborted ? '超时' : '网络失败',
      message: controller.signal.aborted
        ? '请求超时，请检查超时配置'
        : '连接失败，请检查网络、代理和接口地址',
    };
  } finally {
    clearTimeout(timer);
  }
}
module.exports = { Credentials, endpoint, classify, testConnection };
