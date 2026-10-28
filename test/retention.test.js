const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTask, groups, mutate } = require('../src/core/tasks.cjs');

test('future deadlines join today without modifying dates or duplicating tasks', () => {
  const tasks = [
    createTask({ title: 'early plan', planDate: '2026-10-20', dueDate: '2026-11-01' }),
    createTask({ title: 'future plan', planDate: '2026-11-01', dueDate: '2026-11-03' }),
    createTask({ title: 'past', planDate: '2026-10-20', dueDate: '2026-10-23' }),
    createTask({ title: 'no deadline', planDate: '2026-11-01' }),
  ];
  const doc = { version: 1, tasks };
  const raw = JSON.stringify(doc);
  const v = groups(doc, '2026-10-24');
  assert.deepEqual(
    v.today.map((t) => t.id),
    tasks.slice(0, 2).map((t) => t.id),
  );
  assert.equal(v.history[0].id, tasks[2].id);
  assert.equal(v.future[0].id, tasks[3].id);
  assert.equal(JSON.stringify(doc), raw);
  const completed = mutate(doc, { type: 'toggle', id: tasks[0].id });
  assert.equal(groups(completed, '2026-10-24', true).completed.length, 1);
});

test('截止日当天计入今日，次日进入历史，日期与任务 ID 不变且不重复', () => {
  const task = createTask({ title: '截止日边界', planDate: '2026-10-20', dueDate: '2026-10-28' });
  const doc = { version: 1, tasks: [task] };
  const before = JSON.stringify(doc);
  for (const day of ['2026-10-27', '2026-10-28', '2026-10-29']) {
    const view = groups(doc, day);
    assert.deepEqual(
      view.today.map((t) => t.id),
      day <= task.dueDate ? [task.id] : [],
    );
    assert.deepEqual(
      view.history.map((t) => t.id),
      day > task.dueDate ? [task.id] : [],
    );
    assert.equal(
      Object.values(view)
        .flat()
        .filter((t) => t.id === task.id).length,
      1,
    );
  }
  assert.equal(JSON.stringify(doc), before);
  const completed = mutate(doc, { type: 'toggle', id: task.id });
  assert.equal(groups(completed, '2026-10-28', true).today.length, 0);
  assert.equal(groups(completed, '2026-10-28', true).completed[0].id, task.id);
});

test('截止日等于今天时不受计划日期早晚影响，无截止日期仍按原计划分组', () => {
  const tasks = ['2026-10-20', '2026-10-28', '2026-10-30'].map((planDate) =>
    createTask({ title: '当天截止', planDate, dueDate: '2026-10-28' }),
  );
  tasks.push(createTask({ title: '未来计划', planDate: '2026-10-30' }));
  const view = groups({ version: 1, tasks }, '2026-10-28');
  assert.deepEqual(
    view.today.map((t) => t.id),
    tasks.slice(0, 3).map((t) => t.id),
  );
  assert.deepEqual(
    view.future.map((t) => t.id),
    [tasks[3].id],
  );
});

test('recurring instances retain their dates and completion boundaries', () => {
  const task = createTask({
    title: 'daily',
    planDate: '2026-10-23',
    dueDate: '2026-12-01',
    repeat: 'daily',
  });
  const v = groups({ version: 1, tasks: [task] }, '2026-10-24');
  assert.equal(v.history[0].instanceDate, '2026-10-23');
  assert.equal(v.today[0].instanceDate, '2026-10-24');
});
