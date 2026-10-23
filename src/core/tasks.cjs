const crypto = require('node:crypto');
const Ajv = require('ajv');
const ajv = new Ajv({ allErrors: true });
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const nullableDate = { anyOf: [date, { type: 'null' }] };
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'tasks'],
  properties: {
    version: { const: 1 },
    tasks: {
      type: 'array',
      maxItems: 20000,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'title',
          'description',
          'createdAt',
          'planDate',
          'dueDate',
          'completed',
          'completedAt',
          'priority',
          'order',
          'repeat',
          'occurrences',
          'metadata',
        ],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 100 },
          title: { type: 'string', minLength: 1, maxLength: 500 },
          description: { type: 'string', maxLength: 20000 },
          createdAt: { type: 'string', maxLength: 50 },
          planDate: date,
          dueDate: nullableDate,
          completed: { type: 'boolean' },
          completedAt: { type: ['string', 'null'] },
          priority: { enum: ['low', 'normal', 'high'] },
          order: { type: 'number' },
          repeat: { enum: ['none', 'daily'] },
          occurrences: {
            type: 'object',
            propertyNames: date,
            additionalProperties: { type: 'string' },
          },
          metadata: { type: 'object' },
        },
      },
    },
  },
};
const check = ajv.compile(schema);
function today(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00`);
  return !Number.isNaN(+d) && today(d) === s && s >= '2000-01-01' && s <= '2199-12-31';
}
function validate(doc) {
  if (!check(doc))
    throw new Error('任务格式不符合 version 1 Schema：' + ajv.errorsText(check.errors));
  const ids = new Set();
  for (const t of doc.tasks) {
    if (ids.has(t.id)) throw new Error('任务 ID 重复');
    ids.add(t.id);
    if (!t.title.trim() || !validDate(t.planDate) || (t.dueDate && !validDate(t.dueDate)))
      throw new Error('任务标题或日期无效');
    if (
      !Number.isFinite(Date.parse(t.createdAt)) ||
      (t.completedAt && !Number.isFinite(Date.parse(t.completedAt))) ||
      t.completed !== !!t.completedAt
    )
      throw new Error('任务完成状态或时间无效');
    for (const [d, at] of Object.entries(t.occurrences))
      if (!validDate(d) || !Number.isFinite(Date.parse(at)))
        throw new Error('重复任务实例日期无效');
  }
  return doc;
}
function createTask(input, order = 0) {
  return {
    id: crypto.randomUUID(),
    title: String(input.title || '').trim(),
    description: String(input.description || ''),
    createdAt: new Date().toISOString(),
    planDate: input.planDate || today(),
    dueDate: input.dueDate || null,
    completed: false,
    completedAt: null,
    priority: input.priority || 'normal',
    order,
    repeat: input.repeat || 'none',
    occurrences: {},
    metadata: {},
  };
}
function mutate(doc, action) {
  const next = structuredClone(doc);
  if (action.type === 'add')
    next.tasks.push(createTask(action.task, Math.max(-1, ...next.tasks.map((t) => t.order)) + 1));
  else {
    const task = next.tasks.find((t) => t.id === action.id);
    if (!task) throw new Error('任务已被修改或删除，请刷新');
    if (action.type === 'delete') next.tasks = next.tasks.filter((t) => t.id !== action.id);
    else if (action.type === 'edit') {
      for (const key of ['title', 'description', 'planDate', 'dueDate', 'priority', 'repeat'])
        if (Object.hasOwn(action.task, key)) task[key] = action.task[key];
    } else if (action.type === 'toggle') {
      if (task.repeat === 'daily') {
        const d = action.date || today();
        if (d < task.planDate || d > today()) throw new Error('重复任务实例日期超出范围');
        if (task.occurrences[d]) delete task.occurrences[d];
        else task.occurrences[d] = new Date().toISOString();
      } else {
        task.completed = !task.completed;
        task.completedAt = task.completed ? new Date().toISOString() : null;
      }
    } else if (action.type === 'move') {
      const sorted = next.tasks
        .slice()
        .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
      const i = sorted.findIndex((t) => t.id === task.id);
      const j = Math.min(sorted.length - 1, Math.max(0, i + (action.direction < 0 ? -1 : 1)));
      [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
      sorted.forEach((t, index) => {
        t.order = index;
      });
    } else throw new Error('不支持的任务操作');
  }
  return validate(next);
}
function groups(doc, day = today(), all = false) {
  const result = { today: [], history: [], completed: [], future: [] };
  const put = (t, d, done, at) => {
    const row = { ...t, instanceDate: d, completed: done, completedAt: at };
    if (done) {
      if (all || at?.slice(0, 10) === day || today(new Date(at)) === day)
        result.completed.push(row);
    } else result[d < day ? 'history' : d === day ? 'today' : 'future'].push(row);
  };
  for (const t of doc.tasks) {
    if (t.repeat === 'none') put(t, t.planDate, t.completed, t.completedAt);
    else {
      const end = t.planDate > day ? t.planDate : day;
      let d = t.planDate;
      while (d <= end) {
        put(t, d, !!t.occurrences[d], t.occurrences[d] || null);
        const n = new Date(`${d}T12:00:00`);
        n.setDate(n.getDate() + 1);
        d = today(n);
      }
    }
  }
  for (const list of Object.values(result))
    list.sort((a, b) => a.order - b.order || a.instanceDate.localeCompare(b.instanceDate));
  return result;
}
module.exports = { schema, validate, createTask, mutate, groups, today, validDate };
