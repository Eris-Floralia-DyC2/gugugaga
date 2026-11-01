let feishuDailyCache = null,
  feishuDailyLoading = false,
  feishuGroups = [],
  feishuHistoryOffset = 0,
  feishuHealthStamp = '',
  feishuGroupsFetched = false;
let feishuDailySaveChain = Promise.resolve();
function renderFeishuDaily() {
  const page = card('飞书群聊总结');
  let c = page;
  const stamp = JSON.stringify(WS.state.integration?.info?.feishu_daily_connection || {});
  if (stamp !== feishuHealthStamp) {
    feishuHealthStamp = stamp;
    feishuDailyCache = null;
  }
  async function reload(offset = 0) {
    if (feishuDailyLoading) return;
    feishuDailyLoading = true;
    try {
      const value = await WS.call(window.ws.integration('feishu_daily_status', { offset }));
      if (offset && feishuDailyCache)
        value.history = [...feishuDailyCache.history, ...value.history];
      feishuDailyCache = value;
      feishuHistoryOffset = offset;
    } catch (e) {
      WS.error(e);
    } finally {
      feishuDailyLoading = false;
      if (active === 'feishuDaily') render();
    }
  }
  async function act(command, payload) {
    try {
      const result = await WS.call(window.ws.integration(command, payload));
      if (result?.reason) WS.toast(result.reason, result.connected === false);
      else if (command === 'feishu_daily_run') {
        const failed = result.results.filter((r) => r.status === 'failed');
        WS.toast(
          failed.length ? `有 ${failed.length} 个日期处理失败，已有摘要已保留` : '群聊总结已更新',
          !!failed.length,
        );
      } else if (command === 'feishu_daily_test')
        WS.toast(
          result.message_read_verified ? '所选群消息读取成功' : '请查看各群连接结果',
          !result.message_read_verified,
        );
      if (command === 'feishu_daily_connect' && result.connected) feishuGroupsFetched = false;
      feishuDailyCache = null;
      await reload();
      return result;
    } catch (e) {
      WS.error(e);
    }
  }
  const refresh = WS.button('刷新', () => reload());
  refresh.disabled = feishuDailyLoading;
  c.append(
    WS.el(
      'p',
      'notice',
      '按本机自然日保存群聊总结。下次执行会补全前一天的消息；后续事项和截止日期仅展示在摘要中。',
    ),
    refresh,
  );
  if (!feishuDailyCache) {
    c.append(WS.el('p', 'hint', '正在读取飞书总结…'));
    if (!feishuDailyLoading) reload();
    return;
  }
  const data = feishuDailyCache,
    conf = data.config,
    health = data.connection;
  const setup = WS.el('details', 'feishu-settings');
  setup.open = !conf.source;
  setup.append(
    WS.el(
      'summary',
      '',
      `设置 · ${conf.enabled ? '已启用' : '已暂停'} · 每日 ${conf.daily_time} · ${conf.groups.length} 个群`,
    ),
  );
  page.append(
    WS.el(
      'p',
      'hint',
      health.connected
        ? `已连接 · ${conf.source?.account_name || '飞书用户'}`
        : health.reason || '尚未连接飞书',
    ),
  );
  if (conf.source && conf.groups.length)
    page.append(WS.button('立即总结', () => act('feishu_daily_run'), 'primary'));
  page.append(setup);
  c = setup;
  c.append(
    WS.el('h2', '', '连接飞书'),
    WS.el(
      'p',
      'notice',
      health.connected
        ? `已连接 · ${conf.source?.account_name || '飞书用户'}`
        : health.reason || '连接已有飞书账号，或完成一次浏览器授权。',
    ),
  );
  c.append(
    WS.button(health.connected ? '重新连接' : '连接飞书', () => act('feishu_daily_connect')),
  );
  if (health.groups)
    for (const g of health.groups)
      c.append(
        WS.el('p', g.ok ? 'hint' : 'notice', `${g.name}：${g.ok ? '消息读取成功' : g.reason}`),
      );
  const advanced = WS.el('details');
  advanced.append(
    WS.el('summary', '', '首次配置应用（已有连接无需填写）'),
    WS.el(
      'p',
      'hint',
      '没有可复用连接时，先在飞书开放平台创建应用，开启机器人能力，申请用户只读群信息、消息和离线访问权限，发布并获得管理员批准。回调地址：http://127.0.0.1:8001/oauth/callback。',
    ),
  );
  const appId = WS.field('App ID', { maxLength: 100 }),
    appSecret = WS.field('App Secret', { type: 'password', maxLength: 512 });
  advanced.append(
    appId.wrap,
    appSecret.wrap,
    WS.button('保存应用并连接', async () => {
      const result = await act('feishu_daily_configure', {
        app_id: appId.input.value.trim(),
        app_secret: appSecret.input.value,
      });
      appSecret.input.value = '';
      if (result) await act('feishu_daily_connect');
    }),
  );
  c.append(advanced, WS.el('h2', '', '群聊与时间'));
  let chosen = new Map(conf.groups.map((g) => [g.id, { id: g.id, name: g.name }]));
  const query = WS.field('查找群聊', { placeholder: '按群名搜索' });
  const groupList = WS.el('div', 'summary-options');
  function drawGroups() {
    groupList.replaceChildren();
    const all = new Map([...feishuGroups.map((g) => [g.id, g]), ...chosen]);
    for (const g of all.values()) {
      if (
        !chosen.has(g.id) &&
        !g.name.toLocaleLowerCase().includes(query.input.value.trim().toLocaleLowerCase())
      )
        continue;
      const f = WS.field(g.name, { type: 'checkbox', value: chosen.has(g.id) });
      f.wrap.classList.add('summary-option');
      f.input.onchange = () => {
        dirty = true;
        f.input.checked ? chosen.set(g.id, { id: g.id, name: g.name }) : chosen.delete(g.id);
      };
      groupList.append(f.wrap);
    }
    if (!all.size) groupList.append(WS.el('p', 'hint', '点击“获取群聊”，选择需要总结的群。'));
  }
  query.input.oninput = drawGroups;
  const fetchGroups = WS.button('获取群聊', async () => {
    try {
      const result = await WS.call(window.ws.integration('feishu_daily_groups'));
      feishuGroups = result.groups;
      drawGroups();
    } catch (e) {
      WS.error(e);
    }
  });
  if (health.connected && !feishuGroupsFetched) {
    feishuGroupsFetched = true;
    WS.call(window.ws.integration('feishu_daily_groups'))
      .then((result) => {
        feishuGroups = result.groups;
        if (active === 'feishuDaily') drawGroups();
      })
      .catch(WS.error);
  }
  c.append(query.wrap, fetchGroups, groupList);
  drawGroups();
  const manual = WS.el('details');
  manual.append(WS.el('summary', '', '手动添加群 ID'));
  const groupId = WS.field('群 ID', { placeholder: 'oc_…' }),
    groupName = WS.field('群名', { maxLength: 200 });
  manual.append(
    groupId.wrap,
    groupName.wrap,
    WS.button('添加到选择', () => {
      const id = groupId.input.value.trim(),
        name = groupName.input.value.trim();
      if (!/^oc_[A-Za-z0-9_-]+$/.test(id) || !name)
        return WS.error(new Error('请填写有效群 ID 和群名'));
      chosen.set(id, { id, name });
      dirty = true;
      drawGroups();
    }),
  );
  const enabled = WS.field('启用每日总结', {
    type: 'checkbox',
    value: conf.enabled,
  });
  const dailyTime = WS.field('每天执行时间', {
    type: 'time',
    value: conf.daily_time,
    required: true,
  });
  enabled.input.onchange = dailyTime.input.onchange = async () => {
    dirty = true;
    try {
      await save();
      WS.toast('每日时间与启用状态已保存');
    } catch (e) {
      WS.error(e);
    }
  };
  async function save() {
    const settings = {
      enabled: enabled.input.checked,
      daily_time: dailyTime.input.value,
      groups: [...chosen.values()],
    };
    const pending = feishuDailySaveChain
      .catch(() => {})
      .then(() => WS.call(window.ws.integration('feishu_daily_save', { settings })));
    feishuDailySaveChain = pending;
    const result = await pending;
    if (feishuDailySaveChain === pending) dirty = false;
    return result;
  }
  const actions = WS.el('div', 'form-actions');
  actions.append(
    WS.button(
      '保存设置',
      async () => {
        try {
          await save();
          await reload();
          WS.toast('飞书总结设置已保存');
        } catch (e) {
          WS.error(e);
        }
      },
      'primary',
    ),
    WS.button('测试连接', async () => {
      try {
        await save();
        await act('feishu_daily_test');
      } catch (e) {
        WS.error(e);
      }
    }),
    WS.button('立即总结', async () => {
      try {
        await save();
        await act('feishu_daily_run');
      } catch (e) {
        WS.error(e);
      }
    }),
  );
  c.append(
    manual,
    enabled.wrap,
    dailyTime.wrap,
    WS.el('p', 'hint', '群消息将发送至“AI 服务”中已配置的模型进行总结。'),
    WS.el(
      'p',
      'hint',
      '首次选择从今天开始保存。WS 运行或恢复后会补执行错过的日期；暂停期间不自动读取。',
    ),
    actions,
  );
  c = page;
  c.append(WS.el('h2', '', '每日总结'));
  const labels = {
    topics: '主要内容',
    notices: '重要通知',
    conclusions: '明确结论',
    followups: '后续事项',
    dates: '时间与截止日期',
    attention: '需要关注',
  };
  if (!data.history.length)
    c.append(WS.el('p', 'notice', '暂无每日摘要。选择群后可点击“立即总结”。'));
  for (const item of data.history) {
    const panel = WS.el('details', 'daily-summary');
    panel.append(
      WS.el(
        'summary',
        '',
        `${item.name} · ${item.day} · ${item.error ? '待重试' : item.complete ? '已补全' : '待补全'} · ${item.count} 条消息`,
      ),
    );
    if (item.error)
      panel.append(
        WS.el('p', 'notice', item.error + (item.summary ? '；以下保留上次成功结果。' : '')),
      );
    if (item.summary) {
      if (!item.summary.has_text)
        panel.append(
          WS.el(
            'p',
            'hint',
            item.count ? '没有可总结的文字，未调用 AI。' : '当天未读取到消息，未调用 AI。',
          ),
        );
      for (const [key, title] of Object.entries(labels)) {
        if (!item.summary.sections[key].length) continue;
        panel.append(WS.el('h3', '', title));
        for (const b of item.summary.sections[key]) {
          const p = WS.el('p', '', b.text),
            evidence = WS.el('details');
          evidence.append(WS.el('summary', 'hint', '查看依据'), WS.el('p', 'hint', b.quote));
          const sources = item.summary.sources.filter((s) => b.source_ids.includes(s.id));
          for (const s of sources)
            evidence.append(
              WS.el(
                'p',
                'hint',
                `${new Date(s.timestamp * 1000).toLocaleString()} · ${s.message_id}`,
              ),
            );
          panel.append(p, evidence);
        }
      }
      if (item.summary.missing.length) {
        const missing = WS.el('details');
        missing.append(
          WS.el('summary', 'notice', `部分内容未解析（${item.summary.missing.length} 项）`),
        );
        for (const m of item.summary.missing) missing.append(WS.el('p', 'hint', m));
        panel.append(missing);
      }
    }
    c.append(panel);
  }
  if (data.has_more) c.append(WS.button('查看更早的摘要', () => reload(feishuHistoryOffset + 50)));
}
