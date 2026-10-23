/* Bundled application logic. Runtime themes contain no JavaScript. */
window.WS = {};
WS.call = async (promise) => {
  const result = await promise;
  if (!result?.ok) throw new Error(result?.error || '操作失败');
  return result.value;
};
WS.el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};
WS.button = (text, fn, className = 'secondary', title) => {
  const b = WS.el('button', className, text);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', async () => {
    if (b.disabled) return;
    b.disabled = true;
    const token = Symbol();
    WS.pendingActions ||= new Map();
    WS.pendingActions.set(token, {
      stage: text,
      startedAt: Date.now(),
      detail: '等待系统或服务响应',
      done: null,
      total: null,
    });
    try {
      await fn();
    } catch (e) {
      WS.error(e);
    } finally {
      WS.pendingActions.delete(token);
      b.disabled = false;
    }
  });
  return b;
};
WS.toast = (message, error = false) => {
  const t = document.querySelector('#toast');
  t.textContent = message;
  t.classList.toggle('error', error);
  t.style.display = 'block';
  clearTimeout(WS.toastTimer);
  WS.toastTimer = setTimeout(() => (t.style.display = 'none'), error ? 7000 : 3000);
};
WS.error = (e) => WS.toast(e.message || String(e), true);
WS.act = async (action) => {
  try {
    await WS.call(window.ws.task(action, WS.state.revision));
  } catch (e) {
    WS.error(e);
  }
  await WS.refresh();
};
WS.field = (label, options = {}) => {
  const wrap = WS.el('label', 'field');
  wrap.append(WS.el('span', '', label));
  let input;
  if (options.choices) {
    input = WS.el('select');
    for (const choice of options.choices) {
      const [v, l] = Array.isArray(choice) ? choice : [choice, choice];
      const o = WS.el('option', '', l);
      o.value = v;
      input.append(o);
    }
  } else input = WS.el(options.type === 'textarea' ? 'textarea' : 'input');
  if (input.tagName === 'INPUT') input.type = options.type || 'text';
  if (options.name) input.name = options.name;
  if (options.value !== undefined) input.value = String(options.value ?? '');
  if (options.type === 'checkbox') input.checked = !!options.value;
  for (const k of ['min', 'max', 'step', 'placeholder', 'maxLength', 'required'])
    if (options[k] !== undefined) input[k] = options[k];
  wrap.append(input);
  return { wrap, input };
};
WS.editTask = (task = null) => {
  const d = document.querySelector('#task-dialog');
  d.replaceChildren();
  const form = WS.el('form');
  form.append(WS.el('h2', '', task ? '编辑待办' : '给今天加一件事'));
  const fields = {};
  const add = (key, label, options, parent = form) => {
    const f = WS.field(label, { ...options, name: key, value: task?.[key] ?? options.value });
    fields[key] = f.input;
    parent.append(f.wrap);
  };
  add('title', '任务标题', { required: true, maxLength: 500, placeholder: '想要完成什么？' });
  add('description', '备注', { type: 'textarea', maxLength: 20000 });
  const grid = WS.el('div', 'form-grid');
  form.append(grid);
  add('planDate', '计划日期', { type: 'date', value: WS.state.day, required: true }, grid);
  add('dueDate', '截止日期（可选）', { type: 'date' }, grid);
  add(
    'priority',
    '优先级',
    {
      choices: [
        ['normal', '普通'],
        ['high', '高优先级'],
        ['low', '低优先级'],
      ],
      value: 'normal',
    },
    grid,
  );
  add(
    'repeat',
    '重复规则',
    {
      choices: [
        ['none', '不重复 · 未完成跨天延续'],
        ['daily', '每日 · 每天独立完成状态'],
      ],
      value: 'none',
    },
    grid,
  );
  form.append(
    WS.el(
      'p',
      'notice',
      '普通任务不会自动复制。每日任务按日期保存完成记录，未完成的往日实例保留在历史未完成中。',
    ),
  );
  const actions = WS.el('div', 'form-actions');
  actions.append(WS.button('取消', () => d.close()));
  const save = WS.el('button', 'primary', '保存待办');
  save.type = 'submit';
  actions.append(save);
  form.append(actions);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    try {
      const values = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.value]));
      values.title = values.title.trim();
      values.dueDate = values.dueDate || null;
      await WS.call(
        window.ws.task(
          task ? { type: 'edit', id: task.id, task: values } : { type: 'add', task: values },
          WS.state.revision,
        ),
      );
      d.close();
      await WS.refresh();
    } catch (error) {
      WS.error(error);
      await WS.refresh();
    } finally {
      save.disabled = false;
    }
  });
  d.append(form);
  if (!d.open) d.showModal();
  fields.title.focus();
};
WS.deleteTask = (task) => {
  const d = document.querySelector('#task-dialog');
  d.replaceChildren(
    WS.el('h2', '', '删除这条待办？'),
    WS.el(
      'p',
      'notice',
      task.title + '\n每日任务会连同全部实例记录一起删除。之前的文件仍保存在备份中。',
    ),
  );
  const actions = WS.el('div', 'form-actions');
  actions.append(
    WS.button('保留', () => d.close()),
    WS.button(
      '确认删除',
      async () => {
        await WS.act({ type: 'delete', id: task.id });
        d.close();
      },
      'danger',
    ),
  );
  d.append(actions);
  d.showModal();
};
WS.row = (task, compact = false) => {
  const row = WS.el('div', 'task-row' + (task.completed ? ' completed' : ''));
  row.dataset.taskId = task.id;
  const check = WS.button(
    task.completed ? '✓' : '',
    () => WS.act({ type: 'toggle', id: task.id, date: task.instanceDate }),
    'check',
    task.completed ? '撤销完成' : '完成任务',
  );
  check.setAttribute('aria-label', (task.completed ? '撤销完成：' : '完成：') + task.title);
  row.append(check);
  const body = WS.el('div', 'task-body');
  const title = WS.el('div', 'task-title', task.title);
  title.tabIndex = 0;
  title.addEventListener('click', () => WS.editTask(task));
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') WS.editTask(task);
  });
  body.append(title);
  const meta = WS.el('div', 'task-meta');
  const p = WS.el('span', 'priority-dot ' + task.priority);
  meta.append(p);
  if (!compact || task.instanceDate !== WS.state.day)
    meta.append(WS.el('span', '', task.instanceDate || task.planDate));
  if (task.repeat === 'daily') meta.append(WS.el('span', '', '每日'));
  if (task.dueDate)
    meta.append(
      WS.el(
        'span',
        task.dueDate < WS.state.day && !task.completed ? 'overdue' : '',
        '截止 ' + task.dueDate,
      ),
    );
  if (task.completedAt && !compact)
    meta.append(WS.el('span', '', '完成 ' + new Date(task.completedAt).toLocaleString('zh-CN')));
  body.append(meta);
  if (task.metadata?.groupConfirmation?.incomplete)
    body.append(WS.el('span', 'notice', '附件未完整分析'));
  if (!compact && task.description) body.append(WS.el('p', 'task-description', task.description));
  row.append(body);
  const actions = WS.el('div', 'task-actions');
  actions.append(
    WS.button('↑', () => WS.act({ type: 'move', id: task.id, direction: -1 }), '', '上移'),
    WS.button('↓', () => WS.act({ type: 'move', id: task.id, direction: 1 }), '', '下移'),
    WS.button('✎', () => WS.editTask(task), '', '编辑'),
    WS.button('×', () => WS.deleteTask(task), '', '删除'),
  );
  row.append(actions);
  return row;
};
