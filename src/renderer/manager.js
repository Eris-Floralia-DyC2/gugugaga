const pages = {
  tasks: ['☷', '全部待办'],
  history: ['◷', '完成记录'],
  appearance: ['◐', '外观与动画'],
  window: ['▣', '窗口与显示器'],
  llm: ['✦', 'AI 服务'],
  messages: ['✉', '数据源设置'],
  summary: ['≋', '会话总结与任务分析'],
  program: ['⚙', '程序与数据'],
};
let active = decodeURIComponent(location.hash.slice(1)) || 'tasks',
  search = '',
  filter = 'all',
  dirty = false,
  refreshRunning = false;
const content = document.querySelector('#manager-content');
let formFields = {};
const openPage = (name) => {
  if (name === 'new') {
    active = 'tasks';
    render();
    WS.editTask();
    return;
  }
  active = pages[name] ? name : 'tasks';
  dirty = false;
  render();
};
function appendField(parent, key, label, options) {
  const f = WS.field(label, options);
  formFields[key] = f.input;
  f.input.addEventListener('input', () => {
    dirty = true;
  });
  parent.append(f.wrap);
  return f.input;
}
function card(title) {
  const c = WS.el('div', 'settings-card');
  c.append(WS.el('h2', '', title));
  content.append(c);
  return c;
}
function formGrid(parent) {
  const grid = WS.el('div', 'settings-grid');
  parent.append(grid);
  return grid;
}
async function saveSettings(section) {
  const c = structuredClone(WS.state.config);
  for (const [key, input] of Object.entries(formFields)) {
    const value =
      input.type === 'checkbox'
        ? input.checked
        : input.type === 'number'
          ? Number(input.value)
          : input.value;
    const [scope, name] = key.split('.');
    if (name) c[scope][name] = value;
    else c[scope] = value;
  }
  await WS.call(window.ws.config(c));
  dirty = false;
  WS.toast('设置已保存');
  return c;
}
function saveButton(parent) {
  parent.append(WS.button('保存设置', () => saveSettings(), 'primary'));
}
function renderTasks() {
  const s = WS.state,
    stats = WS.el('div', 'stats');
  for (const [n, label] of [
    [s.views.today.length, '今日待办'],
    [s.views.history.length, '历史未完成'],
    [s.views.completed.length, '今日已完成'],
  ]) {
    const c = WS.el('div', 'stat');
    c.append(WS.el('strong', '', String(n)), WS.el('span', '', label));
    stats.append(c);
  }
  content.append(stats);
  const tools = WS.el('div', 'task-tools');
  const q = WS.el('input');
  q.placeholder = '搜索标题与备注';
  q.value = search;
  const select = WS.field('', {
    choices: [
      ['all', '全部任务'],
      ['today', '今日待办'],
      ['history', '历史未完成'],
      ['future', '将来计划'],
      ['rules', '每日规则'],
    ],
    value: filter,
  }).input;
  tools.append(q, select);
  content.append(tools);
  const list = WS.el('div');
  content.append(list);
  function draw() {
    list.replaceChildren();
    const views = WS.state.views;
    let sets =
      filter === 'all'
        ? [
            ['今日待办', views.today],
            ['历史未完成', views.history],
            ['将来计划', views.future],
            ['已完成', views.completed],
          ]
        : filter === 'rules'
          ? [
              [
                '每日规则（编辑会影响整个规则）',
                s.document.tasks
                  .filter((t) => t.repeat === 'daily')
                  .map((t) => ({ ...t, instanceDate: s.day, completed: !!t.occurrences[s.day] })),
              ],
            ]
          : [
              [
                pages[filter]?.[1] ||
                  { today: '今日待办', history: '历史未完成', future: '将来计划' }[filter],
                views[filter],
              ],
            ];
    let total = 0;
    for (const [title, items] of sets) {
      const rows = (items || []).filter((t) =>
        (t.title + ' ' + t.description).toLowerCase().includes(search.toLowerCase()),
      );
      if (!rows.length) continue;
      list.append(WS.el('h2', 'group-title', title + ' · ' + rows.length));
      rows.slice(0, 500).forEach((t) => list.append(WS.row(t)));
      total += rows.length;
      if (rows.length > 500)
        list.append(WS.el('p', 'hint', '当前分组显示前 500 条，请搜索缩小范围。'));
    }
    if (!total)
      list.append(WS.el('div', 'empty-panel', '这里还没有待办。\n创建一个小目标，让今天开始。'));
  }
  q.addEventListener('input', () => {
    search = q.value;
    draw();
  });
  select.addEventListener('change', () => {
    filter = select.value;
    draw();
  });
  draw();
}
function renderHistory() {
  const records = [];
  for (const t of WS.state.document.tasks) {
    if (t.repeat === 'none' && t.completed) records.push({ ...t, instanceDate: t.planDate });
    for (const [date, at] of Object.entries(t.occurrences))
      records.push({ ...t, instanceDate: date, completed: true, completedAt: at });
  }
  records.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  const note = WS.el('p', 'hint', '保留完整完成历史；撤销后任务返回它原计划日期对应的分组。');
  content.append(note);
  records.slice(0, 1000).forEach((t) => content.append(WS.row(t)));
  if (!records.length)
    content.append(WS.el('div', 'empty-panel', '每一件完成的小事，都会记在这里。'));
  if (records.length > 1000)
    content.append(WS.el('p', 'hint', '当前显示最近 1000 条记录，完整记录保留在任务文件。'));
}
function renderAppearance() {
  const a = WS.state.config.appearance;
  const signatureCard = card('个性签名');
  const signature = WS.field('桌面与工作台签名（清空保存可隐藏）', {
    type: 'textarea',
    value: a.signature ?? '留一点空间，给今天。',
    maxLength: 500,
  });
  signature.input.id = 'signature-input';
  const preview = WS.el('p', 'personal-signature signature-preview', signature.input.value);
  preview.id = 'signature-preview';
  signature.input.addEventListener('input', () => {
    dirty = true;
    preview.textContent = signature.input.value;
    preview.hidden = signature.input.value === '';
  });
  signatureCard.append(
    signature.wrap,
    WS.el(
      'small',
      'hint',
      '预览 · 最多 500 字；按纯文本显示。恢复默认会还原两个位置各自的原始文案。',
    ),
    preview,
  );
  const saveSignature = async (value) => {
    const next = structuredClone(WS.state.config);
    next.appearance.signature = value;
    await WS.call(window.ws.config(next));
    dirty = false;
    await WS.refresh();
    WS.toast(value === null ? '已恢复默认签名' : '个性签名已同步');
  };
  const signatureSave = WS.button(
    '保存个性签名',
    () => saveSignature(signature.input.value),
    'primary',
  );
  signatureSave.id = 'signature-save';
  const signatureReset = WS.button('恢复默认签名', () => saveSignature(null));
  signatureReset.id = 'signature-reset';
  signatureCard.append(signatureSave, signatureReset);
  const basic = card('主题与背景');
  const grid = formGrid(basic);
  appendField(grid, 'theme', '外部主题', {
    choices: WS.state.themes,
    value: WS.state.config.theme,
  });
  appendField(grid, 'appearance.fit', '图片适配', {
    choices: [
      ['cover', '铺满 cover'],
      ['contain', '完整 contain'],
    ],
    value: a.fit,
  });
  appendField(grid, 'appearance.background', '便携背景文件名', {
    value: a.background,
    placeholder: '通过下面按钮导入图片',
  });
  appendField(grid, 'appearance.position', '背景定位（百分比）', { value: a.position });
  const actions = WS.el('div', 'actions');
  actions.append(
    WS.button('导入 PNG / JPG / WebP / GIF / APNG', async () => {
      if (dirty) await saveSettings();
      await WS.call(window.ws.window('import-background'));
      await WS.refresh();
    }),
    WS.button('打开主题文件夹', () => WS.call(window.ws.window('open-theme'))),
    WS.button('恢复默认背景', async () => {
      const c = structuredClone(WS.state.config);
      c.appearance.background = '';
      await WS.call(window.ws.config(c));
      dirty = false;
      await WS.refresh();
    }),
  );
  basic.append(
    actions,
    WS.el(
      'p',
      'hint',
      '覆盖顺序：内置基础样式 → 外部主题 CSS → 设置生成的 CSS 变量。手写 CSS 不会被设置保存覆盖。背景资源请导入，CSS 不允许远程 URL。',
    ),
  );
  const visual = card('颜色、透明度与细节');
  const vg = formGrid(visual);
  const colors = [
    ['textColor', '文字颜色'],
    ['accent', '主题主色'],
    ['overlay', '叠加颜色'],
    ['borderColor', '边框颜色'],
  ];
  colors.forEach(([k, l]) => appendField(vg, 'appearance.' + k, l, { type: 'color', value: a[k] }));
  const nums = [
    ['windowOpacity', '整体窗口透明度', 0.25, 1, 0.05],
    ['backgroundOpacity', '背景透明度', 0, 1, 0.05],
    ['cardOpacity', '卡片强度', 0, 1, 0.05],
    ['contentOpacity', '内容透明度', 0.3, 1, 0.05],
    ['brightness', '背景亮度', 0.1, 3, 0.1],
    ['blur', '背景模糊 px', 0, 30, 1],
    ['radius', '圆角 px', 0, 80, 1],
    ['borderWidth', '边框宽度 px', 0, 8, 1],
    ['shadow', '内阴影强度', 0, 1, 0.05],
    ['scale', '背景缩放', 0.2, 4, 0.1],
    ['filter', '叠加滤镜强度', 0, 1, 0.05],
  ];
  nums.forEach(([k, l, min, max, step]) =>
    appendField(vg, 'appearance.' + k, l, { type: 'number', min, max, step, value: a[k] }),
  );
  appendField(vg, 'appearance.border', '显示边框', { type: 'checkbox', value: a.border });
  const fx = card('粒子与性能');
  const fg = formGrid(fx);
  appendField(fg, 'appearance.animations', '启用动态效果', {
    type: 'checkbox',
    value: a.animations,
  });
  appendField(fg, 'appearance.particles', '启用漂浮粒子', { type: 'checkbox', value: a.particles });
  appendField(fg, 'appearance.performance', '性能模式', {
    choices: [
      ['auto', '自动'],
      ['eco', '省电'],
      ['normal', '正常（仍遵守电池策略）'],
    ],
    value: a.performance,
  });
  appendField(fg, 'appearance.particleColor', '粒子颜色', {
    type: 'color',
    value: a.particleColor,
  });
  [
    ['particleCount', '粒子数量', 0, 200, 1],
    ['particleSize', '粒子大小', 0.2, 12, 0.2],
    ['particleSpeed', '粒子速度', 0, 4, 0.1],
    ['particleOpacity', '粒子透明度', 0, 1, 0.05],
    ['particleBrightness', '粒子亮度', 0.1, 3, 0.1],
    ['particleIntensity', '粒子强度', 0, 2, 0.1],
    ['fps', '帧率上限', 5, 60, 1],
  ].forEach(([k, l, min, max, step]) =>
    appendField(fg, 'appearance.' + k, l, { type: 'number', min, max, step, value: a[k] }),
  );
  fx.append(
    WS.el(
      'p',
      'hint',
      '电池模式：粒子数量减少、最高 12 FPS、GIF/APNG 改用静态帧。收起或检测到完全遮挡后暂停。系统“减少动态效果”同样生效。遮挡检测对透明窗口采用保守策略，可能继续降帧渲染。',
    ),
  );
  saveButton(fx);
}
function renderWindow() {
  const c = WS.state.config;
  const p = card('窗口行为');
  const g = formGrid(p);
  appendField(g, 'mode', '窗口层级', {
    choices: [
      ['desktop', '桌面小组件 · 普通窗口可覆盖'],
      ['topmost', 'Always on Top · 始终置顶'],
    ],
    value: c.mode,
  });
  appendField(g, 'snap', '屏幕边缘吸附', { type: 'checkbox', value: c.snap });
  appendField(g, 'width', '窗口宽度（逻辑像素）', {
    type: 'number',
    min: 300,
    max: 1600,
    step: 1,
    value: WS.state.bounds?.width || c.width,
  });
  appendField(g, 'height', '窗口高度（逻辑像素）', {
    type: 'number',
    min: 300,
    max: 1600,
    step: 1,
    value: WS.state.bounds?.height || c.height,
  });
  saveButton(p);
  const a = WS.el('div', 'actions');
  a.append(WS.button('恢复右下角默认位置', () => WS.call(window.ws.window('reset-position'))));
  p.append(
    a,
    WS.el(
      'p',
      'hint',
      '拖动标题栏移动；窗口四边和右下角手柄可缩放。贴近工作区域 16 个逻辑像素时吸附，避开任务栏。桌面模式使用 Windows Shell 子窗口。Explorer 重启恢复带有兼容性风险，具体见测试报告。',
    ),
  );
  const displays = card('显示器与位置记忆');
  for (const d of WS.state.displays) {
    const b = WS.button(
      `${d.label || '显示器'} · ${d.workArea.width} × ${d.workArea.height} · ${d.scaleFactor * 100}%  → 移到此屏`,
      () => WS.call(window.ws.window('move-display', d.id)),
      'screen-item secondary',
    );
    displays.append(b);
  }
  displays.append(
    WS.el(
      'p',
      'hint',
      '保存每块显示器的相对坐标和尺寸。显示器断开时回到可用工作区；重新连接时尝试恢复原位置。不同 DPI 的坐标转换在原生窗口层处理。',
    ),
  );
}
function renderLLM() {
  const l = WS.state.config.llm;
  const c = card('OpenAI 风格 Chat Completions');
  const g = formGrid(c);
  appendField(g, 'llm.baseUrl', 'Base URL', {
    value: l.baseUrl,
    placeholder: 'https://provider.example/v1',
  });
  appendField(g, 'llm.model', 'Model', { value: l.model, placeholder: '填写提供商的模型标识' });
  appendField(g, 'llm.thinking', '思考模式（仅对支持此参数的接口）', {
    choices: [
      ['provider_default', '提供商默认'],
      ['disabled', '关闭思考模式（DeepSeek 结构化提取推荐）'],
    ],
    value: l.thinking || 'provider_default',
  });
  appendField(g, 'llm.timeout', 'Timeout（秒）', {
    type: 'number',
    min: 3,
    max: 120,
    step: 1,
    value: l.timeout,
  });
  appendField(g, 'llm.temperature', 'Temperature', {
    type: 'number',
    min: 0,
    max: 2,
    step: 0.1,
    value: l.temperature,
  });
  appendField(g, 'llm.maxTokens', '测试输出 Token 上限', {
    type: 'number',
    min: 1,
    max: 256,
    step: 1,
    value: l.maxTokens,
  });
  const keyField = WS.field('API Key（Windows 凭据加密）', {
    type: 'password',
    placeholder: WS.state.hasKey ? '已保存；留空保留现有密钥' : '在此输入密钥',
    maxLength: 4096,
  });
  keyField.input.autocomplete = 'off';
  g.append(keyField.wrap);
  const result = WS.el('div', 'llm-result hidden');
  const actions = WS.el('div', 'actions');
  actions.append(
    WS.button('显示 / 隐藏输入', () => {
      keyField.input.type = keyField.input.type === 'password' ? 'text' : 'password';
    }),
    WS.button(
      '保存配置与密钥',
      async () => {
        await saveSettings();
        if (keyField.input.value) {
          await WS.call(window.ws.credential(keyField.input.value));
          keyField.input.value = '';
          keyField.input.placeholder = '已保存；留空保留现有密钥';
        }
        WS.toast('配置已保存，密钥不会回传到界面');
      },
      'primary',
    ),
  );
  const test = WS.button('测试真实推理（可能产生少量 API 费用）', async () => {
    test.disabled = true;
    result.classList.remove('hidden');
    result.textContent = '正在发送短推理请求…';
    try {
      await saveSettings();
      if (keyField.input.value) {
        await WS.call(window.ws.credential(keyField.input.value));
        keyField.input.value = '';
      }
      const r = await WS.call(window.ws.testLLM());
      result.textContent = `${r.ok ? '✓' : '×'} ${r.kind}\n${r.message}`;
    } finally {
      test.disabled = false;
    }
  });
  actions.append(
    test,
    WS.button(
      '清除保存的密钥',
      async () => {
        await WS.call(window.ws.credential(''));
        keyField.input.value = '';
        keyField.input.placeholder = '密钥已清除';
        WS.toast('密钥已清除');
      },
      'danger',
    ),
  );
  c.append(
    actions,
    result,
    WS.el(
      'p',
      'hint',
      '请求仅包含“Reply with OK only.”，不会上传你的待办或聊天记录。Base URL 自动补 /chat/completions；远程地址必须使用 HTTPS，本机地址允许 HTTP。重定向不会携带密钥继续请求。\n密钥受当前 Windows 用户保护，复制到另一台电脑后请重新输入。部分模型只支持 Responses API 或其他参数时，会显示接口不兼容；本版明确支持 Chat Completions。',
    ),
  );
  const advanced = WS.el('details', 'settings-card');
  advanced.id = 'ai-advanced-settings';
  advanced.append(WS.el('summary', '', '高级设置：总结与任务分析'));
  const features = WS.state.integration?.info?.ai_features;
  const fields = {};
  for (const [key, label, prefix] of [
    ['summary', '会话总结', 'summary'],
    ['tasks', '任务分析', 'task'],
  ]) {
    advanced.append(WS.el('h3', '', label));
    const prompt = WS.field(label + '附加提示词', {
      type: 'textarea',
      maxLength: 8000,
      value: features?.[key]?.instructions ?? WS.state.integration?.info?.analysis_prompt ?? '',
    });
    prompt.input.id = 'ai-' + prefix + '-prompt';
    prompt.input.rows = 6;
    const limit = WS.field(label + '输出上限（Token）', {
      type: 'number',
      min: 256,
      max: 32768,
      step: 1,
      value: features?.[key]?.max_tokens ?? 4096,
    });
    limit.input.id = 'ai-' + prefix + '-max-tokens';
    for (const input of [prompt.input, limit.input])
      input.addEventListener('input', () => {
        dirty = true;
      });
    fields[key] = { prompt: prompt.input, limit: limit.input };
    advanced.append(prompt.wrap, limit.wrap);
  }
  const savePrompt = WS.button(
    '保存高级设置',
    async () => {
      const settings = { version: 1 };
      for (const key of ['summary', 'tasks'])
        settings[key] = {
          instructions: fields[key].prompt.value,
          max_tokens: Number(fields[key].limit.value),
        };
      await WS.call(window.ws.integration('save_ai_features', { settings }));
      dirty = false;
      await WS.refresh();
      WS.toast('总结与任务分析的附加提示词、输出上限已分别保存');
    },
    'primary',
  );
  savePrompt.id = 'ai-save-prompt';
  savePrompt.disabled = !WS.state.integration?.info;
  advanced.append(
    WS.el(
      'p',
      'hint',
      '两项独立生效，适用于微信、QQ 及后续添加的会话。已有共用提示词在首次保存前自动沿用。每项提示词最多 8000 字符；输出上限为 256–32768，实际可用范围取决于模型，设置过高时接口可能报错。内置格式与来源核对继续生效。',
    ),
    savePrompt,
  );
  const builtin = WS.el('details');
  builtin.append(WS.el('summary', '', '查看内置提示词与处理限制'));
  for (const [key, label] of [
    ['summary', '会话总结内置提示词'],
    ['tasks', '任务分析内置提示词'],
  ]) {
    const field = WS.field(label, {
      type: 'textarea',
      value: WS.state.integration?.info?.ai_builtin?.[key] || '',
    });
    field.input.readOnly = true;
    field.input.rows = 8;
    builtin.append(field.wrap);
  }
  builtin.append(WS.el('p', 'hint', WS.state.integration?.info?.ai_builtin?.notes || ''));
  advanced.append(builtin);
  c.append(advanced);
}
function renderProgram() {
  const c = card('启动与便携数据');
  appendField(c, 'autostart', 'Windows 用户登录后自动启动', {
    type: 'checkbox',
    value: WS.state.config.autostart,
  });
  saveButton(c);
  const table = WS.el('table', 'table');
  for (const [k, v] of [
    ['版本', WS.state.version],
    ['运行方式', WS.state.packaged ? '便携 EXE' : '开发模式（不写入登录自启）'],
    ['自启实际状态', WS.state.autostartRegistered ? '已注册当前 EXE 路径' : '未注册'],
    ['PrivateRoot', WS.state.privateRoot],
    ['任务存储', 'PrivateRoot/tasks/tasks.json'],
    ['API 密钥', WS.state.hasKey ? '已保存加密凭据' : '未保存'],
  ]) {
    const tr = WS.el('tr');
    tr.append(WS.el('td', '', k), WS.el('td', '', v));
    table.append(tr);
  }
  c.append(table);
  const actions = WS.el('div', 'actions');
  actions.append(
    WS.button('打开私密数据文件夹', () => WS.call(window.ws.window('open-data'))),
    WS.button('打开 JSON 任务文件', () => WS.call(window.ws.window('open-tasks'))),
    WS.button('显示小组件', () => WS.call(window.ws.window('show'))),
    WS.button('真正退出 WS', () => WS.call(window.ws.window('quit')), 'danger'),
  );
  c.append(
    actions,
    WS.el(
      'p',
      'hint',
      '更新前从托盘退出。只替换程序文件，完整保留 PrivateRoot。跨电脑后重新选择原始平台目录并重新授权；不要删除 profile、session 或 Local State。',
    ),
  );
  const migration = card('私密数据迁移');
  migration.append(
    WS.el(
      'p',
      'notice',
      '公开程序包不含身份、任务或凭据。下面的私密迁移包含你选择的数据，默认且当前版本始终不导出凭据；仅保存到 PrivateRoot/exports。导入目标必须为空。',
    ),
  );
  const selection = {};
  for (const [key, label] of [
    ['tasks', '任务及导入去重记录'],
    ['settings', '设置、主题、窗口和数据源（本机目录与登录连接需重新绑定）'],
    ['history', '消息历史、分析和附件副本'],
  ]) {
    const f = WS.field(label, { type: 'checkbox', value: key !== 'history' });
    migration.append(f.wrap);
    selection[key] = f.input;
  }
  migration.append(
    WS.button('导出单独标识的私密迁移包', async () => {
      const v = await WS.call(
        window.ws.privateData('export', {
          selection: Object.keys(selection).filter((k) => selection[k].checked),
        }),
      );
      WS.toast('私密迁移包已保存在 ' + v.directory);
    }),
    WS.button('导入私密迁移包（目标须为空）', () => WS.call(window.ws.privateData('import'))),
    WS.button('迁移整个 PrivateRoot 到其他位置', () => WS.call(window.ws.privateData('relocate'))),
    WS.button('选择新的空 PrivateRoot（保留旧数据）', () =>
      WS.call(window.ws.privateData('relocate', { empty: true })),
    ),
  );
  const backups = card('任务备份与恢复');
  backups.append(
    WS.el('p', 'hint', '每次任务写入保留旧文件，最多 40 份。恢复前也会备份当前文件。'),
  );
  const backupList = WS.el('div');
  backups.append(
    WS.button('查看可恢复的备份', async () => {
      const files = await WS.call(window.ws.window('backup-list'));
      backupList.replaceChildren();
      if (!files.length) backupList.append(WS.el('p', 'hint', '暂无备份。'));
      for (const f of files) {
        backupList.append(
          WS.button(
            f,
            () => {
              const d = document.querySelector('#task-dialog');
              d.replaceChildren(
                WS.el('h2', '', '恢复此任务备份？'),
                WS.el('p', 'notice', f + '\n当前任务文件会另行备份，然后替换为选定备份。'),
                WS.button('取消', () => d.close()),
                WS.button(
                  '确认恢复',
                  async () => {
                    await WS.call(window.ws.window('restore-backup', f));
                    d.close();
                    await WS.refresh();
                  },
                  'primary',
                ),
              );
              d.showModal();
            },
            'screen-item secondary',
          ),
        );
      }
    }),
    backupList,
  );
}
function renderMessages() {
  const snap = WS.state.integration,
    info = snap?.info;
  const intro = card('数据源');
  intro.append(
    WS.el(
      'p',
      'hint',
      '配置连接后，在“会话总结与任务分析”按名称选择会话和时间。执行时自动采集；指定群需要人工核对时会保留每日确认提醒。',
    ),
  );
  if (!info) {
    intro.append(
      WS.button('加载数据源', () =>
        WS.call(window.ws.integration('status')).then(() => WS.refresh()),
      ),
    );
    return;
  }
  const value = structuredClone(info.config);
  const call = async (command, payload = {}) => {
    try {
      const v = await WS.call(window.ws.integration(command, payload));
      dirty = false;
      await WS.refresh();
      WS.toast(v?.reason || '操作已完成', v?.ok === false);
      return v;
    } catch (e) {
      WS.error(e);
      throw e;
    }
  };
  const confirm = (title, body, fn) => {
    const d = document.querySelector('#task-dialog');
    d.replaceChildren(
      WS.el('h2', '', title),
      WS.el('p', 'notice', body),
      WS.button('取消', () => d.close()),
      WS.button(
        '确认',
        async () => {
          await fn();
          d.close();
        },
        'danger',
      ),
    );
    d.showModal();
  };
  const editor = WS.el('div');
  editor.id = 'source-editor';
  const showEditor = (original) => {
    editor.replaceChildren();
    dirty = true;
    const source = structuredClone(
      original || {
        id: 'source-' + crypto.randomUUID(),
        platform: 'wechat',
        account_id: 'pending-' + crypto.randomUUID(),
        account_name: '我的微信',
        db_dir: '',
        enabled: true,
      },
    );
    const field = (label, options) => {
      const f = WS.field(label, options);
      editor.append(f.wrap);
      return f.input;
    };
    editor.append(WS.el('h3', '', original ? '编辑连接' : '添加数据源'));
    const platform = field('平台', {
      choices: [
        ['wechat', '微信'],
        ['feishu', '飞书'],
        ['qq', 'QQ'],
      ],
      value: source.platform,
    });
    platform.id = 'source-platform';
    if (value.sources.some((s) => s.platform === 'qq'))
      editor.append(
        WS.el(
          'p',
          'hint',
          '已有 QQ 数据源。切换登录账号请取消编辑，使用 QQ 卡片上的“切换 QQ 账号”；不需要重复添加。',
        ),
      );
    const name = field('账号显示名称', { value: source.account_name, maxLength: 100 });
    name.id = 'source-account-name';
    const directory = field('微信本机数据目录', {
      value: source.db_dir,
      placeholder: '选择当前账号的 db_storage 文件夹',
    });
    directory.id = 'source-directory';
    directory.readOnly = true;
    const pick = WS.button('选择账号数据目录', async () => {
      const path = await WS.call(window.ws.privateData('choose-directory'));
      if (path) {
        directory.value = path;
        dirty = true;
      }
    });
    pick.id = 'source-choose-directory';
    editor.append(pick);
    const platformChanged = () => {
      directory.closest('label').hidden = pick.hidden = platform.value !== 'wechat';
      if (!original)
        name.value = { wechat: '我的微信', feishu: '我的飞书', qq: '我的 QQ' }[platform.value];
    };
    platform.addEventListener('change', platformChanged);
    platformChanged();
    const save = WS.button(
      '保存并连接',
      async () => {
        if (
          !original &&
          platform.value === 'qq' &&
          WS.state.integration.info.config.sources.some((s) => s.platform === 'qq')
        )
          throw new Error(
            '已有 QQ 数据源。请在它的卡片中使用“切换 QQ 账号”，无需重复添加；旧账号历史会保留。',
          );
        if (platform.value === 'wechat' && !directory.value)
          throw new Error('请先选择微信账号的 db_storage 文件夹');
        const c = structuredClone(WS.state.integration.info.config),
          next = {
            ...source,
            platform: platform.value,
            account_name: name.value.trim(),
            db_dir: platform.value === 'wechat' ? directory.value : '',
            enabled: true,
          };
        if (next.platform === 'wechat')
          next.account_id = directory.value.replaceAll('\\', '/').split('/').at(-2);
        if (original) c.sources = c.sources.map((s) => (s.id === original.id ? next : s));
        else c.sources.push(next);
        const saved = await call('save_config', { config: c });
        const actual = saved.config.sources.find(
          (s) =>
            s.db_dir === next.db_dir &&
            s.platform === next.platform &&
            s.account_name === next.account_name,
        );
        if (!actual) throw new Error('连接已保存，请刷新后重新连接');
        if (actual.platform === 'qq' && !WS.state.integration.info.qq_environment?.prepared) {
          const prepared = await call('prepare_qq');
          if (!prepared) return;
          await WS.call(window.ws.integration('open_qq_login'));
        }
        await call('connect_source', { source_id: actual.id });
        summaryCache = null;
      },
      'primary',
    );
    save.id = 'source-save-connect';
    editor.append(
      save,
      WS.button('取消编辑', () => {
        dirty = false;
        render();
      }),
    );
  };
  const add = WS.button('添加数据源', () => showEditor(null), 'primary');
  add.id = 'source-add';
  intro.append(add, editor);
  if (info.qq_environment?.prepared && !value.sources.some((s) => s.platform === 'qq'))
    intro.append(
      WS.el('p', 'notice', info.qq_session?.reason || 'QQ 环境已准备'),
      WS.button('退出 QQ 后台并暂停采集', () => call('stop_qq'), 'danger'),
    );
  for (const s of value.sources) {
    const box = WS.el('div', 'settings-card');
    box.dataset.sourceId = s.id;
    const meta = info.sources.find((x) => x.id === s.id),
      connection = meta?.connection;
    box.append(
      WS.el(
        'h3',
        '',
        { wechat: '微信', feishu: '飞书', qq: 'QQ' }[s.platform] + ' · ' + s.account_name,
      ),
    );
    box.append(
      WS.el(
        'p',
        'notice',
        !s.enabled
          ? '已停用'
          : s.platform === 'qq'
            ? info.qq_session?.reason || '请刷新 QQ 状态'
            : connection?.reason || '尚未检测，请检测或连接',
      ),
    );
    if (s.platform !== 'qq' && s.enabled && meta?.health?.reason)
      box.append(WS.el('p', 'notice', meta.health.reason));
    for (const [key, label] of [
      ['last_collection', '最近成功采集'],
      ['last_analysis', '最近成功分析'],
    ])
      box.append(
        WS.el(
          'p',
          'hint',
          `${label}：${meta?.health?.[key] ? new Date(meta.health[key] * 1000).toLocaleString() : '尚无成功记录'}`,
        ),
      );
    const last = info.last_collection;
    if (last?.selection?.selected.some((v) => v.source_id === s.id))
      box.append(
        WS.el(
          'p',
          'hint',
          `最近参与的采集批次：${new Date(last.time * 1000).toLocaleString()} · 批次共读取 ${last.read} 条消息${last.errors.length ? ' · 该批次存在读取失败' : ''}`,
        ),
      );
    if (s.platform !== 'qq') {
      box.append(
        WS.button('编辑或重新连接', () => showEditor(s)),
        WS.button('检测连接', () => call('test_source', { source_id: s.id })),
      );
      if (connection?.needs?.includes('client'))
        box.append(
          WS.button('微信已登录，重试连接', () => call('connect_source', { source_id: s.id })),
        );
      if (connection?.needs?.includes('connection_file'))
        box.append(
          WS.button('导入已有连接文件', async () => {
            const v = await call('import_keys', { source_id: s.id });
            if (v) await call('connect_source', { source_id: s.id });
          }),
        );
      if (connection?.needs?.includes('feishu_authorization'))
        box.append(
          WS.el('p', 'hint', '请先在原飞书连接器登录，然后导入。'),
          WS.button('导入已登录的飞书连接', () => call('import_feishu', { source_id: s.id })),
        );
    } else {
      const session = info.qq_session;
      if (session?.accountName)
        box.append(
          WS.el('p', 'hint', '当前登录：' + session.accountName + '（' + session.accountId + '）'),
        );
      box.append(
        WS.el(
          'p',
          'hint',
          `QCE Shell 6.3.2 · ${info.qq_environment?.prepared ? '专用运行环境已准备' : '尚未准备运行环境'}。退出会暂停 QQ 自动采集，重启 WS 后仍保持暂停，需主动启动恢复。`,
        ),
        WS.el(
          'p',
          'hint',
          '第三方 QQ 环境可能写入登录与消息缓存，存在掉线或账号限制风险。QQ 程序仅复制到本机私密目录；跨电脑可能需要重新安装 QQ 并扫码。',
        ),
        WS.button('准备 QQ 环境', () => call('prepare_qq')),
        Object.assign(
          WS.button('启动 QQ 后台', () => call('start_qq')),
          { id: 'qq-start' },
        ),
        Object.assign(
          WS.button('打开 QQ 登录', () => call('open_qq_login')),
          { id: 'qq-login' },
        ),
        Object.assign(
          WS.button('复制登录 Token', () => call('copy_qq_login_token')),
          { id: 'qq-copy-token' },
        ),
        Object.assign(
          WS.button('确认当前账号并连接', () =>
            call('connect_source', { source_id: s.id }).then(() => {
              summaryCache = null;
            }),
          ),
          { id: 'qq-bind' },
        ),
        Object.assign(
          WS.button('刷新 QQ 状态', () => call('status')),
          { id: 'qq-refresh' },
        ),
        Object.assign(
          WS.button('重启 QQ 后台', () => call('restart_qq')),
          { id: 'qq-restart' },
        ),
        Object.assign(
          WS.button('退出 QQ 后台并暂停采集', () => call('stop_qq'), 'danger'),
          { id: 'qq-stop' },
        ),
        Object.assign(
          WS.button('切换 QQ 账号', () =>
            confirm(
              '切换 QQ 账号',
              '将退出 WS 专用 QQ，并打开新账号登录页。旧账号任务和历史保留，新账号需重新选择会话；切回旧账号可恢复它的选择。',
              () =>
                call('switch_qq_account', { source_id: s.id }).then(() => {
                  summaryCache = null;
                }),
            ),
          ),
          { id: 'qq-switch' },
        ),
        WS.el(
          'p',
          'hint',
          '打开登录页或重启后台会自动携带当前 Token。若页面仍要求输入，点击“复制登录 Token”后粘贴即可。网页“退出登录”只退出网页管理会话；结束采集请使用上方退出按钮。',
        ),
      );
    }
    const management = WS.el('details');
    management.append(WS.el('summary', '', '管理'));
    management.append(
      WS.button(s.enabled ? '停用数据源' : '启用数据源', async () => {
        const c = structuredClone(value);
        c.sources.find((v) => v.id === s.id).enabled = !s.enabled;
        await call('save_config', { config: c });
        summaryCache = null;
      }),
    );
    if (s.platform === 'wechat')
      management.append(WS.button('修复图片读取', () => call('scan_media', { source_id: s.id })));
    if (s.platform !== 'qq')
      management.append(
        WS.button('清除连接凭据', () =>
          confirm('清除连接凭据？', '只清除此账号当前连接资料，任务与消息历史保留。', () =>
            call('clear_credentials', { source_id: s.id }),
          ),
        ),
      );
    management.append(
      WS.button('删除此源消息历史', () =>
        confirm('删除消息历史？', '先备份消息库；正式任务、去重记录和凭据保留。', () =>
          call('delete_history', { source_id: s.id }),
        ),
      ),
      WS.button('移除数据源', () =>
        confirm('移除数据源？', '移除运行入口，已保存任务、消息、凭据和总结不会自动删除。', () =>
          call('save_config', {
            config: { ...value, sources: value.sources.filter((v) => v.id !== s.id) },
          }),
        ),
      ),
    );
    box.append(management);
    content.append(box);
  }
  const ai = card('AI 服务');
  ai.append(WS.button('配置 AI 服务与模型', () => openPage('llm')));
  const mcp = card('MCP');
  const open = WS.button('打开 MCP 配置文件夹', async () => {
    await WS.call(window.ws.integration('open_mcp_folder'));
    WS.toast('已打开当前 MCP 配置文件夹');
  });
  open.id = 'mcp-open-folder';
  mcp.append(open);
  const maintenance = WS.el('details');
  maintenance.append(
    WS.el('summary', '', '缓存管理'),
    WS.el('p', 'hint', '只清理解密数据库缓存；不删除任务、凭据、profile、session 或 Local State。'),
    WS.button('清理未使用的缓存', () => call('clean_cache')),
  );
  content.append(maintenance);
}

function render() {
  if (!WS.state) return;
  formFields = {};
  document.querySelector('#navigation').replaceChildren();
  for (const [name, [icon, label]] of Object.entries(pages)) {
    const b = WS.button(
      `${icon}　${label}`,
      () => openPage(name),
      'nav-button' + (active === name ? ' active' : ''),
    );
    document.querySelector('#navigation').append(b);
  }
  document.querySelector('#page-title').textContent = pages[active]?.[1] || '全部待办';
  document.querySelector('#version').textContent = 'WS ' + WS.state.version;
  content.replaceChildren();
  (
    ({
      tasks: renderTasks,
      history: renderHistory,
      appearance: renderAppearance,
      window: renderWindow,
      llm: renderLLM,
      messages: renderMessages,
      summary: renderSummary,
      program: renderProgram,
    })[active] || renderTasks
  )();
}
WS.refresh = async () => {
  if (refreshRunning) return;
  refreshRunning = true;
  try {
    WS.state = await WS.call(window.ws.snapshot());
    const caption = document.querySelector('.sidebar-caption');
    caption.textContent = WS.state.config.appearance.signature ?? '留一点空间，给今天。';
    caption.hidden = WS.state.config.appearance.signature === '';
    WS.renderOperation?.();
    const error = WS.state.error || WS.state.configError || WS.state.statusError;
    document.querySelector('#global-errors').replaceChildren();
    if (error) document.querySelector('#global-errors').append(WS.el('div', 'error-banner', error));
    if (!dirty && !(active === 'llm' && document.activeElement?.closest('#manager-content')))
      render();
  } catch (e) {
    WS.error(e);
  } finally {
    refreshRunning = false;
  }
};
document.querySelector('#new-task').addEventListener('click', () => WS.editTask());
window.ws.subscribe(() => WS.refresh());
window.addEventListener('ws-tab', (e) => openPage(e.detail));
WS.refresh().then(() => {
  if (active === 'new') openPage('new');
});

WS.renderOperation = () => {
  const node = document.querySelector('#operation-progress');
  if (!node) return;
  const s = WS.state?.integration,
    p = s?.running ? s.progress : [...(WS.pendingActions?.values() || [])].at(-1) || s?.progress;
  const busy = s?.running || WS.pendingActions?.size;
  if (!p || (!busy && (!p.finishedAt || Date.now() - p.finishedAt >= 5000))) {
    node.hidden = true;
    return;
  }
  node.hidden = false;
  const elapsed = Math.max(0, Math.floor(((p.finishedAt || Date.now()) - p.startedAt) / 1000));
  node.querySelector('strong').textContent = `${p.stage} · 已耗时 ${elapsed} 秒`;
  const meter = node.querySelector('progress');
  if (p.total > 0 && p.done !== null) {
    meter.max = p.total;
    meter.value = Math.min(p.done, p.total);
  } else meter.removeAttribute('value');
  meter.hidden = !s.running && !WS.pendingActions?.size;
  node.querySelector('small').textContent =
    (p.done !== null ? `已处理 ${p.done}${p.total > 0 ? ' / ' + p.total : ''} · ` : '') +
    (p.detail || '') +
    (s.lastResult?.imported !== undefined ? ` · 新增 ${s.lastResult.imported} 条任务` : '') +
    (s.lastResult?.conversations ? ` · ${s.lastResult.conversations.length} 个会话结果` : '');
  const cancel = node.querySelector('button');
  cancel.hidden = !s.running;
  cancel.disabled = !s.cancelable;
};
document
  .querySelector('#operation-cancel')
  .addEventListener('click', () => WS.call(window.ws.integration('cancel')).catch(WS.error));
setInterval(() => WS.renderOperation(), 250);
document.addEventListener('visibilitychange', () => WS.renderOperation());
