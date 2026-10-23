const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { atomicWrite } = require('./storage.cjs');
const { createImporter } = require('./task-api.cjs');

function workerCommand(root, dataRoot) {
  const exe = path.join(root, 'runtime', 'ws-worker', 'ws-worker.exe');
  if (fs.existsSync(exe)) return [exe, ['--data', dataRoot]];
  const python = path.join(root, '.venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(python)) throw new Error('消息处理运行时缺失，请使用完整便携包或先构建运行时');
  return [python, [path.join(root, 'integration', 'worker.py'), '--data', dataRoot]];
}
function callWorker(root, dataRoot, request, { timeout = 240000, children, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let program, args;
    try {
      [program, args] = workerCommand(root, dataRoot);
    } catch (e) {
      reject(e);
      return;
    }
    const child = spawn(program, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        WS_PRIVATE_ROOT: dataRoot,
        TEMP: path.join(dataRoot, 'temp'),
        TMP: path.join(dataRoot, 'temp'),
        PYTHONUTF8: '1',
        HF_HUB_OFFLINE: '1',
        HF_HUB_DISABLE_TELEMETRY: '1',
        HF_HOME: path.join(dataRoot, 'cache/huggingface'),
        HF_HUB_CACHE: path.join(dataRoot, 'cache/huggingface/hub'),
        HF_XET_CACHE: path.join(dataRoot, 'cache/huggingface/xet'),
        XET_LOG_DIR: path.join(dataRoot, 'logs/xet'),
        XDG_CACHE_HOME: path.join(dataRoot, 'cache/libraries'),
        TORCH_HOME: path.join(dataRoot, 'cache/torch'),
      },
    });
    children?.add(child);
    const output = [];
    let size = 0,
      done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      children?.delete(child);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('消息处理超时；已保存数据保留，可以重试'));
    }, timeout);
    child.on('error', () => finish(new Error('无法启动消息处理程序')));
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        child.kill();
        finish(new Error('消息响应超过限制'));
        return;
      }
      output.push(chunk);
    });
    // No raw parser/provider output in normal logs: it may contain private paths/content.
    child.stderr.setEncoding('utf8');
    let progressText = '';
    child.stderr.on('data', (chunk) => {
      progressText += chunk.toString('utf8');
      if (progressText.length > 65536) progressText = '';
      let newline;
      while ((newline = progressText.indexOf('\n')) >= 0) {
        const line = progressText.slice(0, newline);
        progressText = progressText.slice(newline + 1);
        if (!line.startsWith('WS_PROGRESS ')) continue;
        try {
          const value = JSON.parse(line.slice(12));
          if (
            [
              '准备数据',
              '检测连接',
              '采集消息',
              '解析附件',
              '解析图片',
              '请求 AI',
              '保存结果',
              '完成',
              '失败',
            ].includes(value.stage)
          )
            onProgress?.({
              stage: value.stage,
              done: Number.isFinite(value.done) ? value.done : null,
              total: Number.isFinite(value.total) ? value.total : null,
              detail: typeof value.detail === 'string' ? value.detail.slice(0, 160) : '',
            });
        } catch {}
      }
    });
    child.on('close', (code) => {
      if (done) return;
      try {
        const result = JSON.parse(Buffer.concat(output).toString('utf8'));
        if (code !== 0 || !result.ok) throw new Error(result.error || '消息处理进程异常退出');
        finish(null, result.value);
      } catch (e) {
        finish(e instanceof SyntaxError ? new Error('消息运行时响应无效') : e);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}
function dueSchedule(now, time, lastDay) {
  // Use the user's local Windows day, and catch up after sleep/closed periods.
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const previous = new Date(now);
  previous.setDate(previous.getDate() - 1);
  const yesterday = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}-${String(previous.getDate()).padStart(2, '0')}`;
  const target = clock >= time ? day : yesterday;
  return !lastDay || lastDay < target ? target : null;
}
class Integration extends EventEmitter {
  constructor({ root, dataRoot, repo, config, credentials, disabled = false }) {
    super();
    Object.assign(this, { root, dataRoot, repo, config, credentials, disabled });
    this.children = new Set();
    this.running = false;
    this.stage = '就绪';
    this.error = null;
    this.info = null;
    this.progress = null;
    this.lastResult = null;
    try {
      this.lastTaskResult = JSON.parse(
        fs.readFileSync(path.join(dataRoot, 'state/last-task-result.json'), 'utf8'),
      );
    } catch {
      this.lastTaskResult = null;
    }
    this.cancelled = false;
    this.nextRetry = 0;
    this.importer = (items) => createImporter(repo, dataRoot)(items);
    this.qq = new (require('./qq-shell.cjs').QQShell)(dataRoot);
    this.scheduleFile = path.join(dataRoot, 'state/message-schedule.json');
    try {
      this.lastDay = JSON.parse(fs.readFileSync(this.scheduleFile, 'utf8')).day;
    } catch {
      this.lastDay = null;
    }
    if (!disabled) {
      this.timer = setInterval(() => this.tick().catch(() => {}), 60000);
      this.refresh()
        .then(async () => {
          if (
            !this.qq.isPaused() &&
            this.info.config.sources.some((s) => s.enabled && s.platform === 'qq')
          ) {
            await this.qq.start();
            for (const s of this.info.config.sources.filter(
              (s) => s.enabled && s.platform === 'qq',
            ))
              await this.worker({ command: 'test_source', source_id: s.id });
            await this.refresh();
          }
          return this.tick();
        })
        .catch((e) => {
          this.error = e.message;
          this.emit('change');
        });
    }
  }
  snapshot() {
    return {
      running: this.running,
      stage: this.stage,
      error: this.error,
      info: this.info,
      progress: this.progress,
      lastResult: this.lastResult,
      lastTaskResult: this.lastTaskResult,
      cancelable: this.running && this.stage !== '保存结果',
    };
  }
  update(value) {
    this.stage = value.stage;
    this.progress = { ...this.progress, ...value };
    this.emit('change');
  }
  async worker(request, timeout) {
    const value = await callWorker(this.root, this.dataRoot, request, {
      timeout,
      children: this.children,
      onProgress: (v) => this.running && this.update(v),
    });
    if (this.cancelled && this.running && request.command !== 'status')
      throw new Error('已取消；已保存消息和正式任务保留');
    return value;
  }
  async refresh() {
    this.info = await this.worker({ command: 'status' });
    this.info.qq_session = await this.qq.status().catch(() => ({
      state: 'unavailable',
      paused: this.qq.isPaused(),
      reason: 'QQ 状态检查失败，请刷新或重启 QQ 后台',
    }));
    const qqSource = this.info.config.sources.find((s) => s.platform === 'qq');
    if (
      this.info.qq_session.online &&
      qqSource &&
      qqSource.account_id !== this.info.qq_session.accountId
    ) {
      this.info.qq_session.state = 'account_mismatch';
      this.info.qq_session.reason =
        '当前 QQ 登录账号与数据源绑定不同，请确认当前账号并连接；旧账号历史保留';
    }
    this.emit('change');
    return this.snapshot();
  }
  selection() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dataRoot, 'config/summary.json'), 'utf8'));
    } catch {
      return { version: 1, selected: [], since: 0, until: Math.floor(Date.now() / 1000) };
    }
  }
  async tick(now = new Date()) {
    if (this.disabled || this.running || Date.now() < this.nextRetry || !this.info?.config.enabled)
      return;
    const c = this.info.config,
      day = dueSchedule(now, c.daily_time, this.lastDay),
      pick = this.selection();
    pick.selected = pick.selected.filter(
      (v) =>
        this.info.config.sources.some((s) => s.id === v.source_id && s.enabled) &&
        !(
          this.qq.isPaused() &&
          this.info.config.sources.some((s) => s.id === v.source_id && s.platform === 'qq')
        ) &&
        !this.info.sources.some(
          (s) => s.id === v.source_id && s.platform === 'qq' && s.health?.requires_auth,
        ),
    );
    if (!day || !pick.selected.length) return;
    const end = Math.floor(now.getTime() / 1000);
    try {
      await this.run(
        undefined,
        { ...pick, since: end - c.lookback_days * 86400, until: end },
        c.schedule_action,
      );
      this.lastDay = day;
      atomicWrite(this.scheduleFile, JSON.stringify({ day, completed: new Date().toISOString() }));
    } catch (e) {
      this.error = e.message;
      this.nextRetry = Date.now() + 300000;
      this.emit('change');
    }
  }
  async operation(label, fn) {
    if (this.running) throw new Error('已有操作正在进行，请等待或取消');
    this.running = true;
    this.cancelled = false;
    this.error = null;
    this.lastResult = null;
    this.progress = { stage: label, startedAt: Date.now(), done: null, total: null, detail: '' };
    this.stage = label;
    this.emit('change');
    try {
      const v = await fn();
      this.lastResult = v;
      this.progress = {
        ...this.progress,
        finishedAt: Date.now(),
        stage: '完成',
        detail: '操作完成',
      };
      this.stage = '完成';
      return v;
    } catch (e) {
      this.error = this.cancelled ? '已取消；已保存的消息和任务保留' : e.message;
      this.stage = '失败';
      this.progress = {
        ...this.progress,
        finishedAt: Date.now(),
        stage: this.cancelled ? '已取消' : '失败',
        detail: this.error,
      };
      throw new Error(this.error);
    } finally {
      this.running = false;
      await this.refresh().catch(() => {});
      this.emit('change');
    }
  }
  async run(sourceIds, selection, kind = 'tasks') {
    const pick = structuredClone(selection || this.selection());
    if (sourceIds) pick.selected = pick.selected.filter((s) => sourceIds.includes(s.source_id));
    if (!pick.selected.length) throw new Error('请先按名称选择至少一个会话');
    return this.operation('准备数据', async () => {
      try {
        const llm = { ...this.config.value.llm, key: this.credentials.get() };
        if (!llm.key || !llm.model) throw new Error('请到 AI 服务设置保存 API Key 和模型');
        if (
          this.info?.config.sources.some(
            (s) =>
              s.enabled && s.platform === 'qq' && pick.selected.some((v) => v.source_id === s.id),
          )
        )
          if (!this.qq.isPaused())
            await this.qq.start().catch((e) => {
              this.error = e.message;
            });
        // Persist the snapshot once; later UI changes apply only to future runs.
        // Selection persistence belongs to the UI; scheduled/transient snapshots must not overwrite newer choices.
        const collected = await this.worker({ command: 'collect', selection: pick }, 900000);
        const analysisPick = {
          ...pick,
          selected: pick.selected.filter(
            (v) => !collected.errors.some((e) => e.source === v.source_id && e.chat === v.chat_id),
          ),
        };
        if (!analysisPick.selected.length && collected.errors.length)
          throw new Error('采集消息失败：' + collected.errors.map((e) => e.error).join('；'));
        await this.worker({ command: 'enrich_images', selection: analysisPick, llm }, 900000);
        if (kind === 'summary') {
          const value = await this.worker(
            { command: 'summary_generate', selection: analysisPick, llm },
            900000,
          );
          this.update({
            stage: '保存结果',
            done: value.conversations.length,
            total: value.conversations.length,
            detail: '总结已保存；需要人工核对的指定群会保留每日确认提醒',
          });
          const failed = value.conversations.filter(
            (c) => c.status === 'failed' || c.status === 'blocked',
          );
          if (failed.length === value.conversations.length && failed.length)
            throw new Error(failed.map((c) => c.reason).join('；'));
          return { ...value, read: collected.read, collectionErrors: collected.errors };
        }
        const review = [],
          usefulInformation = [...(this.lastTaskResult?.usefulInformation || [])];
        let imported = 0,
          batches = 0,
          needsReview = false,
          status = 'up_to_date';
        for (let i = 0; i < 50; i++) {
          const existing = this.repo.doc.tasks
            .filter((t) => t.metadata?.messageSource || t.metadata?.wechat)
            .map((t) => {
              const m = t.metadata.messageSource || t.metadata.wechat;
              return {
                id: t.id,
                title: t.title,
                completed: t.completed,
                groupId: m.groupId,
                sourceId: m.sourceId || 'wechat-local',
              };
            });
          const batch = await this.worker(
            { command: 'prepare', selection: analysisPick, existing, llm },
            900000,
          );
          status = batch.status;
          if (!batch.analysis_id) break;
          this.update({
            stage: '保存结果',
            done: imported,
            detail: '写入原任务库；重复任务会合并',
          });
          const result = batch.tasks.length ? this.importer(batch.tasks) : { results: [] };
          await this.worker({
            command: 'ack',
            analysis_id: batch.analysis_id,
            results: result.results,
          });
          imported += result.results.filter((r) => r.status === 'imported').length;
          usefulInformation.push(...(batch.useful_information || []));
          review.push(
            ...(batch.pending || []).map((p) => `“${p.task.title}”：${p.reason}`),
            ...(batch.notes || []),
            ...result.results
              .filter((r) => r.status === 'conflict')
              .map((r) => r.reason || '保留用户修改的任务'),
          );
          batches++;
          needsReview ||= batch.needs_review === true;
          if (i === 49) status = 'backlog';
        }
        if (needsReview && status !== 'backlog') status = 'needs_review';
        const value = {
          ...collected,
          imported,
          batches,
          status,
          action: 'tasks',
          review: [...new Set([...review, ...collected.errors.map((e) => e.error)])].slice(0, 100),
          usefulInformation: [
            ...new Map(
              usefulInformation.map((v) => [JSON.stringify([v.source_ids, v.text, v.quote]), v]),
            ).values(),
          ].slice(-200),
          completedAt: new Date().toISOString(),
        };
        this.lastTaskResult = value;
        atomicWrite(path.join(this.dataRoot, 'state/last-task-result.json'), JSON.stringify(value));
        if (collected.errors.length)
          throw new Error(
            '部分会话同步异常，其他会话结果已保存；' +
              collected.errors.map((e) => e.error).join('；'),
          );
        return value;
      } finally {
        // Known attachment failures survive provider/collection errors. Unknown LLM results
        // never become an ordinary confirmation; the worker uses successful receipts only.
        if (!this.cancelled) {
          const decisions = await this.worker({ command: 'group_confirmations', selection: pick });
          require('./group-confirmations.cjs').reconcile(this.repo, this.dataRoot, decisions);
        }
      }
    });
  }
  async action(command, payload = {}) {
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      Object.hasOwn(payload, 'command') ||
      JSON.stringify(payload).length > 2 * 1024 * 1024
    )
      throw new Error('消息操作参数无效');
    if (command === 'clear_result_messages') {
      if (this.running) throw new Error('请等待当前操作结束后再清空结果消息');
      if (this.lastTaskResult) {
        this.lastTaskResult = {
          ...this.lastTaskResult,
          review: [],
          usefulInformation: [],
          messagesClearedAt: new Date().toISOString(),
        };
        atomicWrite(
          path.join(this.dataRoot, 'state/last-task-result.json'),
          JSON.stringify(this.lastTaskResult),
        );
      }
      atomicWrite(path.join(this.dataRoot, 'state/last-summary.json'), 'null');
      this.lastResult = null;
      this.emit('change');
      return { cleared: true };
    }
    if (command === 'status') return this.refresh();
    if (command === 'cancel') {
      if (this.stage === '保存结果') throw new Error('正在原子保存结果，请稍候');
      this.cancelled = true;
      for (const child of this.children) child.kill();
      return { cancel_requested: true };
    }
    if (command === 'save_summary_selection') return this.worker({ ...payload, command });
    if (['start_qq', 'stop_qq', 'restart_qq', 'switch_qq_account'].includes(command)) {
      return this.operation('检测连接', async () => {
        if (command === 'stop_qq') return this.qq.stop();
        if (command === 'switch_qq_account') {
          const source = this.info?.config.sources.find(
            (s) => s.id === payload.source_id && s.platform === 'qq',
          );
          if (!source) throw new Error('请选择当前 QQ 数据源后切换账号');
          await this.qq.stop('switching');
          await this.worker({ command: 'begin_qq_switch', source_id: source.id });
          await this.qq.start({ explicit: true, forceLogin: true, forSwitch: true });
          return { reason: '请在登录页登录新账号，再点击确认当前账号并连接' };
        }
        const forSwitch = this.qq.session().switching === true;
        if (command === 'restart_qq') return this.qq.restart({ forSwitch, forceLogin: forSwitch });
        return this.qq.start({ explicit: true, forSwitch });
      });
    }
    if (command === 'prepare_qq')
      return this.operation('准备数据', async () => {
        const result = await this.worker(
          {
            command,
            path: payload.path,
            archive: path.join(this.root, 'runtime/qce-shell-v6.3.2.zip'),
          },
          900000,
        );
        await this.qq.start({ explicit: true });
        return result;
      });
    if (
      command === 'connect_source' &&
      this.info?.config.sources.some((s) => s.id === payload.source_id && s.platform === 'qq')
    )
      return this.operation('检测连接', async () => {
        const previous = this.qq.session();
        try {
          await this.qq.start({ explicit: true, forSwitch: previous.switching === true });
          this.qq.setSession({ paused: false, switching: false, reason: '' });
          const result = await this.worker({ ...payload, command }, 900000);
          if (!result.ok) this.qq.setSession(previous);
          else {
            this.nextRetry = 0;
            this.lastDay = null;
          }
          return result;
        } catch (error) {
          this.qq.setSession(previous);
          throw error;
        }
      });
    if (command === 'run' || command === 'task_analyze')
      return this.run(undefined, payload.selection, 'tasks');
    if (command === 'summary_generate') return this.run(undefined, payload.selection, 'summary');
    const allowed = new Set([
      'save_ai_features',
      'save_config',
      'save_analysis_prompt',
      'discover',
      'groups',
      'connect_source',
      'test_source',
      'import_keys',
      'import_feishu',
      'scan_media',
      'clear_credentials',
      'delete_history',
      'clean_cache',
      'summary_options',
    ]);
    if (!allowed.has(command)) throw new Error('不支持的消息操作');
    return this.operation(
      {
        summary_options: '准备数据',
        save_config: '保存设置',
        clean_cache: '清理缓存',
        delete_history: '备份并删除历史',
        clear_credentials: '清除连接凭据',
        import_keys: '验证连接文件',
        import_feishu: '导入登录连接',
        scan_media: '修复图片读取',
      }[command] || '检测连接',
      async () => {
        const result = await this.worker({ ...payload, command }, 900000);
        if (command === 'connect_source' && result.ok) {
          this.nextRetry = 0;
          this.lastDay = null;
        }
        return result;
      },
    );
  }
  close() {
    clearInterval(this.timer);
    for (const child of this.children) child.kill();
    this.children.clear();
  }
}
module.exports = { Integration, callWorker, dueSchedule };
