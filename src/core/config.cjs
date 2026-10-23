const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { atomicWrite, backup } = require('./storage.cjs');
const defaults = {
  version: 1,
  autostart: true,
  mode: 'desktop',
  snap: true,
  theme: 'default',
  width: 400,
  height: 580,
  appearance: {
    signature: null,
    dateCollapsed: false,
    windowOpacity: 1,
    backgroundOpacity: 0.48,
    cardOpacity: 0.86,
    contentOpacity: 1,
    background: '',
    fit: 'cover',
    scale: 1,
    position: '50% 50%',
    brightness: 1,
    blur: 0,
    radius: 22,
    border: true,
    borderColor: '#58766f',
    borderWidth: 1,
    shadow: 0.25,
    textColor: '#eff8f5',
    accent: '#8ce4bd',
    overlay: '#10221b',
    filter: 0,
    animations: true,
    particles: true,
    particleColor: '#a8eed2',
    particleCount: 26,
    particleSize: 2,
    particleSpeed: 0.4,
    particleOpacity: 0.5,
    particleBrightness: 1,
    particleIntensity: 1,
    fps: 30,
    performance: 'auto',
  },
  llm: {
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    timeout: 30,
    temperature: 0.2,
    maxTokens: 32,
    thinking: 'provider_default',
  },
};
function configValidate(c) {
  if (!c || c.version !== 1) throw new Error('不支持的配置版本');
  for (const k of Object.keys(c))
    if (!Object.hasOwn(defaults, k)) throw new Error('未知配置字段：' + k);
  if (
    !['desktop', 'topmost'].includes(c.mode) ||
    !['autostart', 'snap'].every((k) => typeof c[k] === 'boolean')
  )
    throw new Error('窗口配置无效');
  if (!/^[a-zA-Z0-9_-]{1,60}$/.test(c.theme)) throw new Error('主题名称无效');
  for (const k of ['width', 'height'])
    if (!Number.isInteger(c[k]) || c[k] < 300 || c[k] > 1600)
      throw new Error('窗口尺寸需在 300–1600 之间');
  const a = c.appearance;
  // Optional in v1 files: null keeps each surface's original default caption.
  if (a.signature === undefined) a.signature = null;
  if (a.dateCollapsed === undefined) a.dateCollapsed = false;
  if (typeof a.dateCollapsed !== 'boolean') throw new Error('日期折叠设置无效');
  if (a.signature !== null && (typeof a.signature !== 'string' || a.signature.length > 500))
    throw new Error('个性签名需为 500 字以内的纯文本');
  const ranges = {
    windowOpacity: [0.25, 1],
    backgroundOpacity: [0, 1],
    cardOpacity: [0, 1],
    contentOpacity: [0.3, 1],
    scale: [0.2, 4],
    brightness: [0.1, 3],
    blur: [0, 30],
    radius: [0, 80],
    borderWidth: [0, 8],
    shadow: [0, 1],
    filter: [0, 1],
    particleCount: [0, 200],
    particleSize: [0.2, 12],
    particleSpeed: [0, 4],
    particleOpacity: [0, 1],
    particleBrightness: [0.1, 3],
    particleIntensity: [0, 2],
    fps: [5, 60],
  };
  for (const [k, [min, max]] of Object.entries(ranges))
    if (!Number.isFinite(a[k]) || a[k] < min || a[k] > max) throw new Error('外观参数无效：' + k);
  for (const k of ['borderColor', 'textColor', 'accent', 'overlay', 'particleColor'])
    if (!/^#[\da-f]{6}$/i.test(a[k])) throw new Error('颜色格式无效');
  for (const k of ['border', 'animations', 'particles'])
    if (typeof a[k] !== 'boolean') throw new Error('动画配置无效');
  if (
    typeof a.background !== 'string' ||
    a.background.length > 260 ||
    !['cover', 'contain'].includes(a.fit) ||
    !['auto', 'eco', 'normal'].includes(a.performance) ||
    !/^\d{1,3}% \d{1,3}%$/.test(a.position)
  )
    throw new Error('背景参数无效');
  if (
    !Number.isInteger(c.llm.timeout) ||
    c.llm.timeout < 3 ||
    c.llm.timeout > 120 ||
    typeof c.llm.model !== 'string' ||
    c.llm.model.length > 200 ||
    typeof c.llm.baseUrl !== 'string' ||
    c.llm.baseUrl.length > 2000 ||
    !Number.isFinite(c.llm.temperature) ||
    c.llm.temperature < 0 ||
    c.llm.temperature > 2 ||
    !Number.isInteger(c.llm.maxTokens) ||
    c.llm.maxTokens < 1 ||
    c.llm.maxTokens > 256
  )
    throw new Error('LLM 配置无效');
  for (const k of Object.keys(a))
    if (!Object.hasOwn(defaults.appearance, k)) throw new Error('未知外观参数');
  for (const k of Object.keys(c.llm))
    if (!Object.hasOwn(defaults.llm, k)) throw new Error('配置中禁止保存密钥等未知字段');
  if (c.llm.thinking !== undefined && !['provider_default', 'disabled'].includes(c.llm.thinking))
    throw new Error('思考模式配置无效');
  return c;
}
class Config extends EventEmitter {
  constructor(root) {
    super();
    this.root = root;
    this.file = path.join(root, 'config', 'settings.json');
    this.value = structuredClone(defaults);
    this.error = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) atomicWrite(this.file, JSON.stringify(this.value, null, 2));
    this.reload();
    this.watcher = fs.watch(path.dirname(this.file), () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.reload(), 180);
    });
  }
  reload() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''));
      const v = configValidate(raw);
      if (JSON.stringify(this.value) !== JSON.stringify(v) || this.error) {
        this.value = v;
        this.error = null;
        this.emit('change');
      }
    } catch (e) {
      this.error = e.message;
      this.emit('change');
    }
  }
  save(value) {
    this.reload();
    if (this.error) throw new Error('请先修复外部配置文件：' + this.error);
    const v = configValidate(value);
    backup(this.file, path.join(this.root, 'backups'));
    atomicWrite(this.file, JSON.stringify(v, null, 2));
    this.value = v;
    this.emit('change');
    return this.value;
  }
  close() {
    clearTimeout(this.timer);
    this.watcher.close();
  }
}
module.exports = { Config, defaults, configValidate };
