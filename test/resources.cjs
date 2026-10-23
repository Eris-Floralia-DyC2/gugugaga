const fs = require('node:fs');
const path = require('node:path');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = async (c) => {
  const output = path.join(c.dataRoot, 'logs', 'artifacts');
  fs.mkdirSync(output, { recursive: true });
  const config = structuredClone(c.config.value);
  config.mode = 'topmost';
  c.config.save(config);
  const samples = [];
  await wait(5000);
  for (const state of ['visible', 'hidden']) {
    if (state === 'hidden') c.hideWidget();
    await wait(2500);
    c.app.getAppMetrics();
    for (let i = 0; i < 30; i++) {
      await wait(1000);
      const metrics = c.app.getAppMetrics().map((m) => ({
        type: m.type,
        cpu: m.cpu.percentCPUUsage,
        workingSetKB: m.memory.workingSetSize,
      }));
      samples.push({ state, time: Date.now(), metrics });
    }
  }
  const summarize = (state) => {
    const list = samples.filter((s) => s.state === state);
    const cpu = list.map((s) => s.metrics.reduce((n, m) => n + m.cpu, 0));
    const mem = list.map((s) => s.metrics.reduce((n, m) => n + m.workingSetKB, 0) / 1024);
    return {
      samples: list.length,
      avgCpuPercent: cpu.reduce((a, b) => a + b, 0) / cpu.length,
      maxCpuPercent: Math.max(...cpu),
      firstWorkingSetMiB: mem[0],
      lastWorkingSetMiB: mem.at(-1),
      minWorkingSetMiB: Math.min(...mem),
      maxWorkingSetMiB: Math.max(...mem),
    };
  };
  fs.writeFileSync(
    path.join(output, 'resources.json'),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        description:
          '30 seconds each after warmup; process working-set sums include shared pages; no screen capture or manager window; not a long-duration leak test',
        visible: summarize('visible'),
        hidden: summarize('hidden'),
        samples,
      },
      null,
      2,
    ),
  );
  c.quit();
};
