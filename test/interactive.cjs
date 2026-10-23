// Fixed acceptance operations for an isolated test profile. No generic script execution.
const fs = require('node:fs');
const path = require('node:path');
const { desktopCapturer, screen } = require('electron');
module.exports = async (c) => {
  const out = path.join(c.dataRoot, 'logs', 'interactive');
  fs.mkdirSync(out, { recursive: true });
  let last = '',
    lastCommand = '';
  let tick = 0;
  const samples = [];
  let capturing = false;
  await c.openManager('tasks');
  const capture = async () => {
    if (capturing) return;
    capturing = true;
    try {
      const r = c.native.rect(c.native.hwnd(c.widget));
      const topLeft = screen.screenToDipPoint({ x: r.x, y: r.y });
      const d = screen.getDisplayNearestPoint(topLeft);
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.round(d.size.width * d.scaleFactor),
          height: Math.round(d.size.height * d.scaleFactor),
        },
      });
      const s = sources.find((s) => s.display_id === String(d.id));
      if (s) {
        const origin = screen.dipToScreenPoint(d.bounds);
        const crop = {
          x: Math.max(0, r.x - origin.x),
          y: Math.max(0, r.y - origin.y),
          width: r.width,
          height: r.height,
        };
        fs.writeFileSync(path.join(out, 'desktop-widget.png'), s.thumbnail.crop(crop).toPNG());
      }
    } catch {
    } finally {
      capturing = false;
    }
  };
  const interval = setInterval(async () => {
    try {
      const snap = c.snapshot();
      const diag = c.native.diagnostics(c.widget);
      const data = {
        ...snap,
        native: diag,
        performance: await c.widget.webContents.executeJavaScript(
          '({text:document.querySelector("[data-slot=status]")?.textContent,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}})',
        ),
        metrics: c.app.getAppMetrics().map((m) => ({
          type: m.type,
          cpu: m.cpu?.percentCPUUsage,
          memoryKB: m.memory?.workingSetSize,
        })),
      };
      delete data.document;
      delete data.views;
      fs.writeFileSync(path.join(out, 'state.json'), JSON.stringify(data, null, 2));
      samples.push({ timestamp: Date.now(), metrics: data.metrics });
      if (samples.length > 180) samples.shift();
      fs.writeFileSync(path.join(out, 'metrics.json'), JSON.stringify(samples, null, 2));
      if (tick++ % 3 === 0) await capture();
      const file = path.join(out, 'command.json');
      if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, 'utf8');
        if (text !== lastCommand) {
          lastCommand = text;
          const cmd = JSON.parse(text);
          if (cmd.action === 'mode') {
            const config = structuredClone(c.config.value);
            config.mode = cmd.mode;
            c.config.save(config);
          } else if (cmd.action === 'show') c.showWidget();
          else if (cmd.action === 'hide') c.hideWidget();
          else if (cmd.action === 'manager') await c.openManager(cmd.tab || 'tasks');
          else if (cmd.action === 'move') {
            const display = screen.getAllDisplays().find((d) => String(d.id) === cmd.displayId);
            if (display)
              c.setBounds(require('../src/windows/geometry.cjs').defaultBounds(display.workArea));
          } else if (cmd.action === 'capture') await capture();
          else if (cmd.action === 'quit') {
            clearInterval(interval);
            c.quit();
          }
        }
      }
    } catch (e) {
      fs.writeFileSync(path.join(out, 'error.txt'), String(e.stack));
    }
  }, 1000);
};
