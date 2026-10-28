const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { groups, today } = require('../src/core/tasks.cjs');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
module.exports = async (c) => {
  const out = path.join(c.dataRoot, 'logs', 'deadline');
  fs.mkdirSync(out, { recursive: true });
  const checks = [];
  const js = (code) => c.widget.webContents.executeJavaScript(code);
  const until = async (fn) => {
    for (let i = 0; i < 100; i++) {
      if (await fn()) return;
      await wait(100);
    }
    throw Error('界面同步超时');
  };
  try {
    const day = c.snapshot().day,
      past = new Date(day + 'T12:00:00');
    past.setDate(past.getDate() - 2);
    if (!process.argv.includes('--deadline-restore')) {
      assert.equal(c.repo.doc.tasks.length, 0);
      c.repo.apply(
        { type: 'add', task: { title: '今天截止的验收任务', planDate: today(past), dueDate: day } },
        c.repo.revision,
      );
      c.repo.apply(
        { type: 'add', task: { title: '没有截止日期的历史任务', planDate: today(past) } },
        c.repo.revision,
      );
    }
    const task = c.repo.doc.tasks.find((t) => t.title === '今天截止的验收任务');
    assert.ok(task);
    assert.equal(task.dueDate, day);
    assert.equal(task.planDate, today(past));
    await until(
      async () =>
        await js(
          `document.querySelectorAll('[data-slot="today"] [data-task-id="${task.id}"]').length===1`,
        ),
    );
    assert.equal(
      await js(
        `document.querySelectorAll('[data-slot="history"] [data-task-id="${task.id}"]').length`,
      ),
      0,
    );
    assert.equal(c.snapshot().views.history.length, 1);
    checks.push('实际桌面：截止日期当天归入今日，历史区不重复，普通历史任务保留');
    const before = JSON.stringify(c.repo.doc),
      next = new Date(day + 'T12:00:00');
    next.setDate(next.getDate() + 1);
    assert.equal(groups(c.repo.doc, today(next)).history.filter((t) => t.id === task.id).length, 1);
    assert.equal(JSON.stringify(c.repo.doc), before);
    checks.push('次日分组：未完成任务进入历史，存储日期和 ID 不改写');
    c.repo.apply({ type: 'toggle', id: task.id }, c.repo.revision);
    await until(
      async () =>
        await js(
          `document.querySelectorAll('[data-slot="completed"] [data-task-id="${task.id}"]').length===1`,
        ),
    );
    assert.equal(c.snapshot().views.today.length, 0);
    c.repo.apply({ type: 'toggle', id: task.id }, c.repo.revision);
    await until(
      async () =>
        await js(
          `document.querySelectorAll('[data-slot="today"] [data-task-id="${task.id}"]').length===1`,
        ),
    );
    assert.equal(c.repo.doc.tasks.length, 2);
    assert.equal(c.repo.doc.tasks.find((t) => t.id === task.id).planDate, today(past));
    checks.push('完成/撤销：自动刷新到正确分组，任务数量保持不变');
    await c.widget.webContents.executeJavaScript(
      'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))',
    );
    fs.writeFileSync(
      path.join(out, '截止日当天.png'),
      (await c.widget.webContents.capturePage()).toPNG(),
    );
    fs.writeFileSync(
      path.join(out, process.argv.includes('--deadline-restore') ? 'restart.json' : 'result.json'),
      JSON.stringify(
        {
          version: c.snapshot().version,
          packaged: c.app.isPackaged,
          checks,
          restored: process.argv.includes('--deadline-restore'),
          remote_AI_called: false,
        },
        null,
        2,
      ),
    );
    c.quit();
  } catch (error) {
    fs.writeFileSync(
      path.join(out, 'failed.json'),
      JSON.stringify({ checks, error: error.stack }, null, 2),
    );
    c.app.exit(1);
  }
};
