const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { atomicWrite } = require('../core/storage.cjs');

function startRecovery({ dataRoot, executable, args }) {
  const file = path.join(dataRoot, 'state', 'recovery.json');
  const session = crypto.randomUUID();
  const state = { version: 1, session, parentPid: process.pid, cleanExit: false };
  atomicWrite(file, JSON.stringify(state));
  const child = spawn(
    executable,
    [__filename, file, String(process.pid), session, JSON.stringify(args)],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  child.on('error', () => {});
  child.unref();
  state.guardianPid = child.pid;
  atomicWrite(file, JSON.stringify(state));
  return () => {
    try {
      atomicWrite(file, JSON.stringify({ ...state, cleanExit: true }));
    } catch {}
  };
}

// A separate, headless Node process survives destruction of the foreign Shell parent.
// It restarts only for a changed Explorer process, never for an ordinary user quit.
function monitor() {
  const [file, pidText, session, argsText] = process.argv.slice(2);
  const parentPid = Number(pidText);
  const args = JSON.parse(argsText);
  const koffi = require('koffi');
  const u = koffi.load('user32.dll');
  const find = u.func('void * __stdcall FindWindowW(str16, str16)');
  const owner = u.func('uint32 __stdcall GetWindowThreadProcessId(void *, _Out_ uint32 *)');
  const shellPid = () => {
    const hwnd = find('Progman', null);
    if (!hwnd) return 0;
    const p = [0];
    owner(hwnd, p);
    return p[0];
  };
  const initialShell = shellPid();
  let deadAt = 0;
  const timer = setInterval(() => {
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (state.session !== session || state.cleanExit) return process.exit(0);
      try {
        process.kill(parentPid, 0);
        return;
      } catch {}
      if (!deadAt) deadAt = Date.now();
      const current = shellPid();
      if (current && current !== initialShell) {
        clearInterval(timer);
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        const child = spawn(process.execPath, args, {
          env,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          cwd: path.dirname(process.execPath),
        });
        child.on('error', () => process.exit(1));
        child.unref();
        fs.appendFileSync(
          path.join(path.dirname(file), 'recovery-events.log'),
          'shell_restart_recovered\n',
        );
        setTimeout(() => process.exit(0), 500);
      } else if (Date.now() - deadAt > 20000) process.exit(0);
    } catch {
      process.exit(0);
    }
  }, 1000);
}

module.exports = { startRecovery };
if (require.main === module) monitor();
