// Headless helper waits for Electron to release profile/Local State before copying.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { copyVerified, initialize, walk, sha } = require('./private-root.cjs');
const { atomicWrite } = require('./storage.cjs');
async function relocate(job) {
  const retained = path.join(job.target, 'backups', 'previous-root-' + Date.now());
  const pending = job.link + '.pending';
  let oldMoved = false,
    backupVerified = false,
    removalStarted = false;
  const isLink = (p) => {
    try {
      return fs.lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  };
  try {
    for (let i = 0; i < 300; i++) {
      let active = true;
      try {
        process.kill(job.pid, 0);
      } catch {
        active = false;
      }
      if (!active) break;
      if (i === 299) throw new Error('退出等待超时，目录未更改');
      await new Promise((r) => setTimeout(r, 100));
    }
    const original = fs.realpathSync(job.source);
    if (
      original !== path.resolve(job.source) ||
      !fs.existsSync(path.join(original, 'private-root.json')) ||
      original === path.parse(original).root
    )
      throw new Error('来源不是已核对的 WS 私密根目录');
    if (fs.existsSync(job.target) || fs.existsSync(pending))
      throw new Error('目标或未完成迁移入口已存在，请核对后重试');
    const relative = path.relative(original, path.resolve(job.target));
    if (!relative.startsWith('..') && !path.isAbsolute(relative))
      throw new Error('新根目录不能位于旧根目录内部');
    if (job.empty) initialize(job.target);
    else copyVerified(job.source, job.target);
    fs.mkdirSync(path.dirname(retained), { recursive: true });
    // Pending is a filesystem pointer only. Startup can resolve the verified new
    // copy even if the old-directory removal is interrupted on a different drive.
    fs.symlinkSync(job.target, pending, 'junction');
    try {
      fs.renameSync(original, retained);
      oldMoved = true;
      backupVerified = true;
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      copyVerified(original, retained);
      backupVerified = true;
      for (const rel of walk(retained))
        if (sha(path.join(retained, rel)) !== sha(path.join(original, rel)))
          throw new Error('旧根目录备份核对失败');
      // The exact, marker-checked source is removed only after two verified copies.
      removalStarted = true;
      fs.rmSync(original, { recursive: true });
      oldMoved = true;
    }
    if (isLink(job.link)) fs.unlinkSync(job.link);
    try {
      fs.symlinkSync(job.target, job.link, 'junction');
    } catch (e) {
      if (oldMoved) {
        try {
          fs.renameSync(retained, original);
          oldMoved = false;
        } catch {}
      }
      if (!fs.existsSync(job.link) && fs.existsSync(original) && job.link !== original)
        fs.symlinkSync(original, job.link, 'junction');
      throw e;
    }
    fs.unlinkSync(pending);
    atomicWrite(
      path.join(job.target, 'logs', 'relocation.json'),
      JSON.stringify({
        version: 1,
        ok: true,
        target: job.target,
        retained,
      }),
    );
  } catch (e) {
    if (!oldMoved && !removalStarted && fs.existsSync(job.source) && fs.existsSync(pending))
      fs.unlinkSync(pending);
    atomicWrite(
      path.join(fs.existsSync(pending) ? job.target : job.source, 'logs', 'relocation.json'),
      JSON.stringify({
        version: 1,
        ok: false,
        error: e.message,
        backupVerified,
        retained,
        new_root_active: fs.existsSync(pending),
      }),
    );
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.WS_PRIVATE_ROOT;
  spawn(job.executable, job.args, {
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: path.dirname(job.executable),
  }).unref();
}
if (require.main === module)
  relocate(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))).catch(() => process.exit(1));
module.exports = { relocate };
