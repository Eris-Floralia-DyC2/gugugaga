const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
class Themes extends EventEmitter {
  constructor(root, builtin) {
    super();
    this.dir = path.join(root, 'themes');
    this.builtin = builtin;
    fs.mkdirSync(this.dir, { recursive: true });
    const dest = path.join(this.dir, 'default');
    if (!fs.existsSync(dest)) fs.cpSync(builtin, dest, { recursive: true });
    this.watch();
  }
  watch() {
    this.watcher = fs.watch(this.dir, { recursive: true }, () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.emit('change'), 250);
    });
  }
  list() {
    return fs
      .readdirSync(this.dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^[\w-]{1,60}$/.test(e.name))
      .map((e) => e.name);
  }
  read(name) {
    if (!/^[\w-]{1,60}$/.test(name)) throw new Error('主题名称无效');
    const fallbackHtml = fs.readFileSync(path.join(this.builtin, 'widget.html'), 'utf8'),
      fallbackCss = fs.readFileSync(path.join(this.builtin, 'style.css'), 'utf8');
    let error = null,
      html,
      css;
    try {
      const folder = path.join(this.dir, name);
      html = fs.readFileSync(path.join(folder, 'widget.html'), 'utf8');
      css = fs.readFileSync(path.join(folder, 'style.css'), 'utf8');
      if (html.length > 100000 || css.length > 200000) throw new Error('主题文件过大');
      if (/@import|url\s*\(|expression\s*\(|javascript:|\\/i.test(css))
        throw new Error('CSS 禁止脚本、外部导入、URL 和转义；背景请通过设置导入');
    } catch (e) {
      error = e.message;
      html = fallbackHtml;
      css = fallbackCss;
    }
    return { name, html, css, error, version: 1, fallbackHtml, fallbackCss };
  }
  close() {
    clearTimeout(this.timer);
    this.watcher.close();
  }
}
module.exports = { Themes };
