let lastTheme = '',
  themeError = null,
  perf = { paused: false, eco: false, fps: 30, reason: '正常' },
  completedOpen = false;
const requiredSlots = [
  'toolbar',
  'date',
  'progress',
  'quick-add',
  'today',
  'history',
  'future',
  'completed',
  'status',
];
function slot(name) {
  return document.querySelector(`[data-slot="${name}"]`);
}
async function loadTheme() {
  const t = await WS.call(window.ws.theme());
  const signature = t.html + '\n' + t.css;
  if (signature === lastTheme) return;
  const clean = DOMPurify.sanitize(t.html, {
    ALLOWED_TAGS: [
      'article',
      'header',
      'footer',
      'main',
      'section',
      'nav',
      'div',
      'span',
      'h1',
      'h2',
      'p',
    ],
    ALLOWED_ATTR: ['class', 'data-slot', 'aria-label'],
    ALLOW_DATA_ATTR: false,
  });
  const template = document.createElement('template');
  template.innerHTML = clean;
  if (
    requiredSlots.some((s) => template.content.querySelectorAll(`[data-slot="${s}"]`).length !== 1)
  ) {
    themeError = '主题缺少或重复必要插槽，已使用最近有效布局或内置默认布局。';
    if (lastTheme) return;
    template.innerHTML = DOMPurify.sanitize(t.fallbackHtml);
    t.css = t.fallbackCss;
    t.error = themeError;
  }
  document.querySelector('#theme-root').replaceChildren(template.content);
  let style = document.querySelector('#theme-style');
  if (!style) {
    style = WS.el('style');
    style.id = 'theme-style';
    document.head.append(style);
  }
  style.textContent = t.css;
  lastTheme = signature;
  themeError = t.error;
  slot('toolbar').append(
    WS.button('↗', () => WS.call(window.ws.window('manager', 'tasks')), '', '管理空间'),
    WS.button('⋯', () => WS.call(window.ws.window('menu')), '', '菜单'),
    WS.button('−', () => WS.call(window.ws.window('hide')), '', '收起到托盘'),
  );
  const dateSlot = slot('date');
  dateSlot.tabIndex = 0;
  dateSlot.setAttribute('role', 'button');
  const toggleDate = async () => {
    await WS.call(window.ws.window('toggle-date'));
    await WS.refresh();
  };
  dateSlot.addEventListener('dblclick', (e) => {
    e.preventDefault();
    toggleDate().catch(WS.error);
  });
  dateSlot.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleDate().catch(WS.error);
    }
  });
  const drag = document.querySelector('.widget-header') || slot('toolbar');
  drag.addEventListener('pointerdown', (e) => {
    if (e.button === 0 && !e.target.closest('button,input,select,a')) {
      e.preventDefault();
      WS.call(window.ws.window('drag', 'move')).catch(WS.error);
    }
  });
  const form = WS.el('form');
  const input = WS.el('input');
  input.placeholder = '添加一件想完成的事…';
  input.maxLength = 500;
  input.setAttribute('aria-label', '快速添加待办');
  const add = WS.el('button', '', '+');
  add.title = '添加待办';
  form.append(input, add);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    add.disabled = true;
    try {
      await WS.call(
        window.ws.task({ type: 'add', task: { title: input.value } }, WS.state.revision),
      );
      input.value = '';
      await WS.refresh();
    } catch (error) {
      WS.error(error);
      await WS.refresh();
    } finally {
      add.disabled = false;
    }
  });
  slot('quick-add').append(form);
}
function section(name, title, tasks, showEmpty = false) {
  const root = slot(name);
  root.replaceChildren();
  if (!tasks.length && !showEmpty) return;
  const heading = WS.el('h2', 'section-heading', title);
  heading.append(WS.el('small', '', String(tasks.length)));
  root.append(heading);
  const list = WS.el('div', 'task-list');
  tasks.forEach((t) => list.append(WS.row(t, true)));
  if (!tasks.length)
    list.append(WS.el('div', 'empty-note', '今天还很开阔。\n写下一件小事，从这里开始。'));
  root.append(list);
}
WS.refresh = async () => {
  try {
    WS.state = await WS.call(window.ws.snapshot());
    await loadTheme();
    const s = WS.state,
      a = s.config.appearance;
    WS.effects?.configure(a);
    const root = document.documentElement;
    const vars = {
      '--text': a.textColor,
      '--accent': a.accent,
      '--card-opacity': a.cardOpacity,
      '--content-opacity': a.contentOpacity,
      '--radius': a.radius + 'px',
      '--border-width': (a.border ? a.borderWidth : 0) + 'px',
      '--border-color': a.borderColor,
      '--shadow': a.shadow,
      '--brightness': a.brightness,
      '--blur': a.blur + 'px',
      '--bg-opacity': a.backgroundOpacity,
      '--bg-fit': a.fit,
      '--bg-scale': a.scale,
      '--bg-position': a.position,
      '--overlay': a.overlay,
      '--filter': a.filter,
    };
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    const date = new Date(s.day + 'T12:00:00');
    const main = WS.el('div');
    main.append(
      WS.el('h1', '', date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })),
      WS.el(
        'div',
        'weekday',
        date.toLocaleDateString('zh-CN', { weekday: 'long', year: 'numeric' }),
      ),
    );
    slot('date').replaceChildren(main, WS.el('span', 'day-number', s.day.slice(-2)));
    slot('date').classList.toggle('date-collapsed', a.dateCollapsed === true);
    document.body.classList.toggle('date-is-collapsed', a.dateCollapsed === true);
    slot('date').setAttribute('aria-expanded', String(!a.dateCollapsed));
    slot('date').title = a.dateCollapsed ? '双击展开日期区域' : '双击折叠日期区域';
    if (a.dateCollapsed) slot('date').append(WS.el('span', 'date-fold-hint', '双击展开日期'));
    const { today, history, completed, future } = s.views;
    const total = today.length + history.length + completed.length;
    const caption = WS.el('div', 'progress-caption');
    caption.append(
      WS.el(
        'span',
        'personal-signature',
        a.signature ?? (total ? '给今天，一点进展' : '慢慢来，每一步都算数'),
      ),
      WS.el('strong', '', `${completed.length} / ${total} 已完成`),
    );
    caption.querySelector('.personal-signature').hidden = a.signature === '';
    const track = WS.el('div', 'progress-track');
    const bar = WS.el('span');
    bar.style.width = (total ? (completed.length / total) * 100 : 0) + '%';
    track.append(bar);
    slot('progress').replaceChildren(caption, track);
    section('today', '今日待办', today, true);
    section('history', '历史未完成', history);
    section('future', '即将到来', future.slice(0, 3));
    const group = WS.el('details');
    group.open = completedOpen;
    group.addEventListener('toggle', () => {
      completedOpen = group.open;
    });
    const summary = WS.el('summary', 'completed-summary', `已完成  ·  ${completed.length}`);
    summary.append(WS.el('span', '', '⌄'));
    const list = WS.el('div', 'task-list completed-list');
    completed.forEach((t) => list.append(WS.row(t, true)));
    group.append(summary, list);
    slot('completed').replaceChildren(group);
    const error = s.error || s.configError || s.statusError || themeError;
    slot('status').classList.toggle('error-status', !!error);
    slot('status').replaceChildren(
      WS.el('span', '', error || '● 已保存到本地'),
      WS.el('span', '', error ? '请打开管理窗口' : perf.reason),
    );
  } catch (e) {
    WS.error(e);
  }
};
window.ws.subscribe(() => WS.refresh());
window.ws.performance((p) => {
  perf = p;
  WS.effects?.setPerformance(p);
  if (WS.state) WS.refresh();
});
for (const direction of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
  const h = WS.el('div', 'resize ' + direction);
  h.title = '拖动调整窗口大小';
  h.addEventListener('pointerdown', (e) => {
    if (e.button === 0) {
      e.preventDefault();
      WS.call(window.ws.window('drag', direction)).catch(WS.error);
    }
  });
  document.querySelector('#resize-handles').append(h);
}
WS.refresh();
