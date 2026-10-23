let summaryCache = null,
  summaryLoading = false;
// Page-session state survives ordinary redraws; only the selection is persisted.
let summarySaveChain = Promise.resolve(),
  summaryExecuting = false;
const summaryUI = { draft: '', query: '', expanded: false, mode: 'multi', recent: [] };
function renderSummary() {
  const c = card('会话总结与任务分析');
  c.append(
    WS.el(
      'p',
      'hint',
      '选择会话和时间后执行。系统自动采集并分析所选范围；任务分析写入原任务库。指定微信群、QQ群需要人工核对时会生成每日确认任务，语音等未解析附件会明确标记。',
    ),
  );
  const settings = WS.button('打开数据源设置', () => openPage('messages'));
  c.append(settings);
  async function load() {
    if (summaryLoading) return;
    summaryLoading = true;
    try {
      summaryCache = await WS.call(window.ws.integration('summary_options'));
    } catch (e) {
      WS.error(e);
    } finally {
      summaryLoading = false;
      if (active === 'summary' && summaryCache) render();
    }
  }
  c.append(
    WS.button('刷新有权访问的会话列表', () => {
      summaryCache = null;
      return load();
    }),
  );
  if (!summaryCache) {
    c.append(WS.el('p', 'notice', summaryLoading ? '正在加载会话名称…' : '正在连接数据源…'));
    if (!summaryLoading) load();
    return;
  }
  const cached = summaryCache;
  const readable = (value) => String(value ?? '').replace(/\b[a-f0-9]{32,128}\b/gi, '消息记录');
  const platformName = (value) =>
    ({ wechat: '微信', qq: 'QQ', feishu: '飞书' })[value] || '消息来源';
  const accountName = (sid) =>
    readable(
      WS.state.integration?.info?.config.sources.find((s) => s.id === sid)?.account_name ||
        cached.conversations.find((s) => s.source_id === sid)?.account_name ||
        '已保存账号',
    );
  for (const s of cached.sources.filter((s) => !s.ready))
    c.append(
      WS.el('p', 'notice', s.platform + ' · ' + (s.account_name || '账号') + '：' + s.reason),
    );
  const chosen = new Set(
    (cached.selection?.selected || []).map((s) => JSON.stringify([s.source_id, s.chat_id])),
  );
  const local = (stamp) =>
    new Date(stamp * 1000 - new Date(stamp * 1000).getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 19);
  const now = Math.floor(Date.now() / 1000);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);
  const tonight = new Date();
  tonight.setHours(23, 59, 59, 0);
  if (cached.window_mode === 'rolling' && cached.selection) {
    cached.selection.since = Math.floor(yesterday.getTime() / 1000);
    cached.selection.until = Math.floor(tonight.getTime() / 1000);
  }
  const search = WS.field('按会话名称搜索', {
    placeholder: '输入备注、昵称或群名，按 Enter 搜索',
    value: summaryUI.draft,
  });
  search.input.id = 'summary-search';
  c.append(search.wrap);
  const mode = WS.field('选择方式', {
    choices: [
      ['multi', '多选'],
      ['single', '单选'],
    ],
    value: summaryUI.mode,
  });
  c.append(mode.wrap);
  const times = WS.el('div', 'settings-grid');
  const since = WS.field('总结开始时间（本地时间）', {
    type: 'datetime-local',
    step: 1,
    value: local(cached.selection?.since ?? Math.floor(yesterday.getTime() / 1000)),
  });
  const until = WS.field('总结结束时间（本地时间）', {
    type: 'datetime-local',
    step: 1,
    value: local(cached.selection?.until ?? Math.floor(tonight.getTime() / 1000)),
  });
  since.input.id = 'summary-since';
  until.input.id = 'summary-until';
  times.append(since.wrap, until.wrap);
  c.append(times);
  const counter = WS.el('p', 'hint');
  counter.id = 'summary-counter';
  counter.setAttribute('aria-live', 'polite');
  const searchStatus = WS.el('p', 'hint');
  searchStatus.id = 'summary-search-status';
  searchStatus.setAttribute('role', 'status');
  const list = WS.el('div', 'summary-options');
  list.style.maxHeight = '320px';
  list.style.overflow = 'auto';
  const options = cached.conversations.filter((o) => o.chat_id !== 'notifymessage');
  for (const item of cached.selection?.selected || [])
    if (!options.some((o) => o.source_id === item.source_id && o.chat_id === item.chat_id))
      options.push({
        ...item,
        name: '已保存但当前不可访问的会话',
        platform: '未知/已移除',
        account_id: item.source_id,
        ready: false,
      });
  options.sort((a, b) => a.name.localeCompare(b.name));
  const inputs = [];
  const update = () => {
    counter.textContent = `已选 ${chosen.size} 个会话`;
    const focused = document.activeElement;
    const rank = (key) => {
      const i = summaryUI.recent.indexOf(key);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    const ordered = [...inputs].sort(
      (a, b) =>
        Number(chosen.has(b.key)) - Number(chosen.has(a.key)) ||
        (chosen.has(a.key) ? rank(a.key) - rank(b.key) : 0) ||
        a.order - b.order,
    );
    let matches = 0;
    for (const e of ordered) {
      const match = e.names.some((n) => n.includes(summaryUI.query));
      if (match) matches++;
      e.input.checked = chosen.has(e.key);
      e.wrap.classList.toggle('selected', chosen.has(e.key));
      e.wrap.hidden = !chosen.has(e.key) && (!summaryUI.expanded || !match);
      list.append(e.wrap); // Move the same DOM node; never rebind an index-based click.
    }
    if (focused && list.contains(focused)) focused.focus({ preventScroll: true });
    searchStatus.textContent = !summaryUI.expanded
      ? '输入名称并按 Enter 展开搜索结果；已选会话始终置顶。'
      : matches
        ? `找到 ${matches} 个匹配会话；已选会话置顶显示。`
        : '没有找到匹配会话，请尝试其他备注、昵称或群名称。';
    cached.selection = selection();
  };
  const selection = () => ({
    version: 1,
    selected: [...chosen].map((k) => {
      const [source_id, chat_id] = JSON.parse(k);
      return { source_id, chat_id };
    }),
    since: Math.floor(new Date(since.input.value).getTime() / 1000),
    until: Math.floor(new Date(until.input.value).getTime() / 1000),
  });
  for (const o of options) {
    const key = JSON.stringify([o.source_id, o.chat_id]);
    const wrap = WS.el('div', 'summary-option');
    const label = WS.el('label', 'summary-option-label');
    const input = WS.el('input');
    input.type = 'checkbox';
    input.checked = chosen.has(key);
    const text = WS.el('div', 'summary-option-text');
    const duplicate = options.some((other) => other !== o && other.name === o.name);
    const platform = { wechat: '微信', feishu: '飞书', qq: 'QQ' }[o.platform] || o.platform;
    text.append(
      WS.el('strong', 'summary-name', readable(o.name)),
      WS.el(
        'small',
        'hint',
        `${platform} · ${o.kind === 'private' ? '私聊' : '群聊'}${duplicate ? ' · ' + accountName(o.source_id) + ' · 同名会话 ' + (options.filter((v) => v.name === o.name).indexOf(o) + 1) : ''}`,
      ),
    );
    label.append(input, text);
    wrap.append(label);
    const row = { input, wrap };
    row.input.dataset.sourceId = o.source_id;
    row.input.dataset.chatId = o.chat_id;
    row.input.dataset.summaryName = o.name;
    const details = WS.el('details', 'summary-option-details');
    details.append(
      WS.el('summary', '', '会话详情'),
      WS.el(
        'p',
        'hint',
        `账号：${accountName(o.source_id)}\n平台：${platformName(o.platform)}\n会话：${readable(o.name)}`,
      ),
    );
    row.wrap.append(
      WS.el('small', 'hint', o.ready ? '连接就绪' : '请到数据源设置修复连接'),
      details,
    );
    row.input.addEventListener('change', () => {
      if (row.input.checked) {
        if (mode.input.value === 'single') chosen.clear();
        chosen.add(key);
        summaryUI.recent = [key, ...summaryUI.recent.filter((k) => k !== key)];
      } else chosen.delete(key);
      dirty = true;
      update();
      if (row.input.checked) list.scrollTop = 0;
      persistPick();
    });
    inputs.push({
      key,
      input: row.input,
      wrap: row.wrap,
      order: inputs.length,
      names: [o.name, o.remark, o.nickname, ...(o.aliases || [])]
        .filter(Boolean)
        .map((n) => n.toLocaleLowerCase()),
    });
    list.append(row.wrap);
  }
  let composing = false;
  search.input.addEventListener('compositionstart', () => {
    composing = true;
  });
  search.input.addEventListener('compositionend', () => {
    composing = false;
    summaryUI.draft = search.input.value;
  });
  search.input.addEventListener('input', () => {
    summaryUI.draft = search.input.value;
    dirty = true;
  });
  search.input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.stopPropagation();
    if (composing || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    summaryUI.query = search.input.value.trim().toLocaleLowerCase();
    summaryUI.expanded = true;
    update();
  });
  mode.input.addEventListener('change', () => {
    summaryUI.mode = mode.input.value;
    if (mode.input.value === 'single' && chosen.size > 1) {
      const first = summaryUI.recent.find((k) => chosen.has(k)) || [...chosen][0];
      chosen.clear();
      chosen.add(first);
      dirty = true;
      update();
      persistPick();
    }
  });
  since.input.addEventListener('input', () => {
    dirty = true;
    cached.selection = selection();
    persistPick();
  });
  until.input.addEventListener('input', () => {
    dirty = true;
    cached.selection = selection();
    persistPick();
  });
  function persistPick() {
    const pick = selection();
    if (!Number.isFinite(pick.since) || !Number.isFinite(pick.until) || pick.since > pick.until)
      return;
    cached.window_mode =
      pick.since === Math.floor(yesterday.getTime() / 1000) &&
      pick.until === Math.floor(tonight.getTime() / 1000)
        ? 'rolling'
        : 'custom';
    summarySaveChain = summarySaveChain
      .catch(() => {})
      .then(async () => {
        await WS.call(window.ws.integration('save_summary_selection', { selection: pick }));
      });
    summarySaveChain.catch((e) => WS.error(new Error('会话选择未保存：' + e.message)));
  }
  update();
  c.append(counter, list, searchStatus);
  const resultArea = WS.el('div');
  const show = (value) => {
    resultArea.replaceChildren();
    if (!value) return;
    resultArea.append(
      WS.el(
        'p',
        'notice',
        `生成时间：${new Date(value.created * 1000).toLocaleString()} · 请求范围：${new Date(value.requested.since * 1000).toLocaleString()} 至 ${new Date(value.requested.until * 1000).toLocaleString()} · 创建待办：${value.tasks_created}`,
      ),
    );
    for (const item of value.conversations) {
      const box = WS.el('div', 'settings-card');
      const current = cached.conversations.find(
        (o) => o.source_id === item.source_id && o.chat_id === item.chat_id,
      );
      box.append(WS.el('h3', '', readable(current?.name || item.name)));
      const identity = WS.el('details');
      identity.append(
        WS.el('summary', 'hint', '平台与来源详情'),
        WS.el(
          'p',
          'hint',
          `${platformName(item.platform)} · ${accountName(item.source_id)}\n${readable(current?.name || item.name)}`,
        ),
      );
      box.append(identity);
      if (item.reason) box.append(WS.el('p', 'notice', readable(item.reason)));
      if (item.coverage) {
        const v = item.coverage;
        box.append(
          WS.el(
            'p',
            'hint',
            `范围内索引消息 ${v.indexed_in_range} 条 · 本次检查 ${v.examined} 条 · 实际发送 ${v.sent} 条\n实际消息时间：${v.first_message ? new Date(v.first_message * 1000).toLocaleString() : '无'} 至 ${v.last_message ? new Date(v.last_message * 1000).toLocaleString() : '无'}${v.limited ? ' · 内容受数量或长度限制' : ''}`,
          ),
        );
      }
      for (const [key, label] of [
        ['topics', '主要话题'],
        ['notices', '重要通知'],
        ['conclusions', '明确结论'],
        ['uncertainties', '待确认事项'],
      ]) {
        box.append(WS.el('h4', '', label));
        if (!item[key]?.length)
          box.append(
            WS.el(
              'p',
              'hint',
              item.status === 'failed' || item.status === 'blocked'
                ? '本次总结未生成，请查看上方失败原因。'
                : '暂无有充分依据的项目。',
            ),
          );
        for (const bullet of item[key] || []) {
          const d = WS.el('details');
          d.append(
            WS.el('summary', '', readable(bullet.text)),
            WS.el('blockquote', '', readable(bullet.quote)),
            WS.el(
              'p',
              'hint',
              '来源：' +
                bullet.source_ids
                  .map((id) => {
                    const n = (item.sources || []).findIndex((s) => s.id === id);
                    return n >= 0 ? '消息 ' + (n + 1) : '相关消息';
                  })
                  .join('、'),
            ),
          );
          box.append(d);
        }
      }
      for (const missing of item.missing || []) box.append(WS.el('p', 'notice', readable(missing)));
      if (item.sources?.length) {
        const d = WS.el('details');
        d.append(WS.el('summary', '', '查看本次总结的消息来源'));
        for (const [n, m] of item.sources.entries())
          d.append(
            WS.el(
              'p',
              'hint',
              `消息 ${n + 1} · ${new Date(m.timestamp * 1000).toLocaleString()}\n${readable(m.text)}`,
            ),
          );
        box.append(d);
      }
      resultArea.append(box);
    }
  };
  const execute = async (kind) => {
    if (summaryExecuting) return;
    if (!chosen.size) throw new Error('请至少选择一个会话');
    summaryExecuting = true;
    generateButton.disabled = analyzeButton.disabled = true;
    try {
      const pick = selection();
      await summarySaveChain;
      await WS.call(window.ws.integration('save_summary_selection', { selection: pick }));
      cached.selection = pick;
      dirty = true;
      const value = await WS.call(
        window.ws.integration(kind === 'summary' ? 'summary_generate' : 'task_analyze', {
          selection: pick,
        }),
      );
      if (kind === 'summary') {
        cached.last_result = value;
        show(value);
      } else
        WS.toast(
          `检查 ${value.read} 条消息，新增 ${value.imported} 条待办${value.status === 'backlog' ? '；还有新内容待分析，可再次执行' : value.status === 'needs_review' ? '；部分内容需要人工核对' : '；已处理内容自动跳过'}`,
        );
      dirty = false;
    } finally {
      summaryExecuting = false;
      generateButton.disabled = analyzeButton.disabled = false;
      await WS.refresh();
    }
  };
  const generateButton = WS.button('生成总结', () => execute('summary'), 'primary');
  generateButton.id = 'summary-generate';
  const analyzeButton = WS.button('执行任务分析', () => execute('tasks'));
  analyzeButton.id = 'summary-analyze';
  generateButton.disabled = analyzeButton.disabled =
    summaryExecuting || !!WS.state.integration?.running;
  c.append(
    WS.el('p', 'hint', '会话与有效时间范围自动保存；取消选择只影响后续执行，不删除已有数据。'),
    generateButton,
    analyzeButton,
  );
  const schedule = WS.el('details');
  schedule.append(WS.el('summary', '', '定时执行'));
  const conf = WS.state.integration?.info?.config;
  if (conf) {
    const enabled = WS.field('每天按当前已保存会话执行', { type: 'checkbox', value: conf.enabled });
    const clock = WS.field('本地执行时间', { type: 'time', value: conf.daily_time });
    const days = WS.field('每次回看天数', {
      type: 'number',
      min: 1,
      max: 365,
      value: conf.lookback_days,
    });
    const action = WS.field('执行内容', {
      choices: [
        ['summary', '生成总结'],
        ['tasks', '任务分析'],
      ],
      value: conf.schedule_action,
    });
    schedule.append(
      enabled.wrap,
      clock.wrap,
      days.wrap,
      action.wrap,
      WS.button('保存定时规则', async () => {
        const config = {
          ...WS.state.integration.info.config,
          enabled: enabled.input.checked,
          daily_time: clock.input.value,
          lookback_days: Number(days.input.value),
          schedule_action: action.input.value,
        };
        await summarySaveChain;
        await WS.call(window.ws.integration('save_config', { config }));
        WS.toast('定时规则已保存');
        dirty = false;
        await WS.refresh();
      }),
    );
  }
  c.append(schedule);
  const lastTask = WS.state.integration?.lastTaskResult;
  if (lastTask) {
    const panel = WS.el('div', 'settings-card');
    panel.append(
      WS.el('h2', '', '最近任务分析结果'),
      WS.el(
        'p',
        'notice',
        `读取 ${lastTask.read} 条消息 · 新增 ${lastTask.imported} 条待办 · 完成 ${lastTask.batches} 批分析`,
      ),
      WS.button('查看原任务库', () => openPage('tasks')),
      WS.button('清空下方消息', async () => {
        await WS.call(window.ws.integration('clear_result_messages'));
        cached.last_result = null;
        show(null);
        dirty = false;
        await WS.refresh();
        WS.toast('结果消息已清空，已有待办与聊天缓存保留');
      }),
    );
    if (lastTask.review?.length) {
      panel.append(WS.el('h3', '', '待确认事项'));
      for (const note of lastTask.review) panel.append(WS.el('p', 'hint', readable(note)));
    }
    if (lastTask.usefulInformation?.length) {
      panel.append(WS.el('h3', '', '重要信息（保留最近有效结果）'));
      for (const info of lastTask.usefulInformation)
        panel.append(WS.el('p', 'hint', readable(info.text)));
    }
    content.append(panel);
  }
  content.append(resultArea);
  show(cached.last_result);
}
