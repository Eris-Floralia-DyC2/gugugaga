// Read-only acceptance against the real portable data after an explicitly requested upgrade.
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow } = require('electron');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = async ({ widget, openManager, repo, dataRoot, integration }) => {
  await openManager('tasks');
  await wait(700);
  const manager = BrowserWindow.getAllWindows().find((w) => w !== widget);
  const expected = repo.doc.tasks.filter((t) => t.metadata?.messageSource?.platform === 'wechat');
  const text = await manager.webContents.executeJavaScript('document.body.innerText');
  const visible = expected.filter((t) => text.includes(t.title));
  const out = path.join(dataRoot, 'logs');
  await manager.webContents
    .capturePage()
    .then((i) => fs.writeFileSync(path.join(out, 'live-manager.png'), i.toPNG()));
  await widget.webContents
    .capturePage()
    .then((i) => fs.writeFileSync(path.join(out, 'live-widget.png'), i.toPNG()));
  for (let i = 0; i < 600 && (!integration.info || integration.running); i++) await wait(100);
  const result = {
    time: new Date().toISOString(),
    expected_tasks: expected.length,
    visible_tasks: visible.length,
    task_store_and_frontend: expected.length > 0 && expected.length === visible.length,
    task_ids: expected.map((t) => t.id),
    integration_error: integration.error,
    schedule_completed_today: integration.lastDay,
  };
  fs.writeFileSync(
    path.join(out, 'live-frontend-validation.json'),
    JSON.stringify(result, null, 2),
  );
};
