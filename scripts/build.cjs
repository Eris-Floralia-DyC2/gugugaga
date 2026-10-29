const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
(async () => {
  const root = path.resolve(__dirname, '..');
  const paths = require('../src/core/private-root.cjs');
  const resolvedPrivate = paths.resolvePrivateRoot(root);
  for (const name of [
    'src',
    'assets',
    'defaults',
    'test',
    'docs',
    'scripts',
    'integration',
    'runtime',
    'licenses',
  ]) {
    const relative = path.relative(path.join(root, name), resolvedPrivate);
    if (!relative.startsWith('..') && !path.isAbsolute(relative))
      throw new Error('PrivateRoot 不能位于公开构建输入目录内');
  }
  if (resolvedPrivate === fs.realpathSync(root)) throw new Error('项目根目录不能作为 PrivateRoot');
  const privateRoot = paths.initialize(resolvedPrivate);
  const version = require('../package.json').version;
  for (const name of ['src', 'assets', 'defaults', 'test', 'docs', 'runtime', 'licenses']) {
    const folder = path.join(root, name);
    if (fs.lstatSync(folder).isSymbolicLink())
      throw new Error('Build input contains a directory link');
    paths.walk(folder);
  }
  // Preflight before copying large inputs. Only explicitly reviewed input names can enter a package; their licenses remain separate.
  const runtimeRoot = path.join(root, 'runtime');
  const runtimeNames = new Set([
    'ws-worker',
    'qce-shell-v6.3.2.zip',
    'QCE-6.3.2-source.zip',
    'QCE-LICENSE',
    'NapCat-LICENSE.txt',
  ]);
  for (const name of fs.readdirSync(runtimeRoot)) {
    if (!runtimeNames.has(name)) throw new Error('runtime 包含未审核文件；请移至私密目录后重试');
  }
  if (!fs.existsSync(path.join(runtimeRoot, 'ws-worker/ws-worker.exe')))
    throw new Error('先构建独立 worker');
  const qqFiles = [...runtimeNames].filter((name) => name !== 'ws-worker');
  const qqCount = qqFiles.filter((name) => fs.existsSync(path.join(runtimeRoot, name))).length;
  if (qqCount && qqCount !== qqFiles.length) throw new Error('QQ 资源、源码和许可证必须成套保留');
  for (const rel of paths.walk(runtimeRoot)) {
    if (
      /(^|[\\/])(WS-Private|secrets|profile|session|exports)([\\/]|$)|\.(dpapi|db|sqlite3?|log)(-|$)/i.test(
        rel,
      )
    )
      throw new Error('runtime 包含私密文件或运行数据，拒绝打包');
  }
  const scratch = path.join(privateRoot, 'build', 'packager-' + crypto.randomUUID());
  try {
    const stage = path.join(scratch, 'source');
    fs.mkdirSync(stage, { recursive: true });
    for (const name of [
      'src',
      'assets',
      'defaults',
      'package.json',
      'package-lock.json',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
      'NOTICE',
      'licenses',
    ])
      fs.cpSync(path.join(root, name), path.join(stage, name), { recursive: true });
    for (const name of [
      'smoke.cjs',
      'hotkey.cjs',
      'deadline.cjs',
      'lifecycle.cjs',
      'flow-040.cjs',
      'qq-controls.cjs',
      'optimizations-052.cjs',
      'optimizations-053.cjs',
      'interactive.cjs',
      'resources.cjs',
      'live-import.cjs',
      'fixtures',
    ])
      if (fs.existsSync(path.join(root, 'test', name)))
        fs.cpSync(path.join(root, 'test', name), path.join(stage, 'test', name), {
          recursive: true,
        });
    fs.mkdirSync(path.join(stage, 'node_modules'), { recursive: true });
    const lock = require('../package-lock.json');
    for (const entry of fs.readdirSync(path.join(root, 'node_modules'))) {
      if (entry.startsWith('.')) continue;
      const packagePath = path.join(root, 'node_modules', entry);
      const add = (name, p) => {
        if (!fs.existsSync(path.join(p, 'package.json'))) return;
        if (fs.lstatSync(p).isSymbolicLink())
          throw new Error('Dependency input contains a directory link');
        paths.walk(p);
        if (lock.packages['node_modules/' + name] && !lock.packages['node_modules/' + name].dev)
          fs.cpSync(p, path.join(stage, 'node_modules', name), { recursive: true });
      };
      if (entry.startsWith('@'))
        for (const sub of fs.readdirSync(packagePath))
          add(entry + '/' + sub, path.join(packagePath, sub));
      else add(entry, packagePath);
    }
    const { packager } = await import('@electron/packager');
    const [built] = await packager({
      dir: stage,
      name: 'WS',
      executableName: 'WS',
      platform: 'win32',
      arch: 'x64',
      out: path.join(scratch, 'output'),
      overwrite: false,
      prune: false,
      asar: false,
      icon: path.join(root, 'assets/ws.ico'),
      appVersion: version,
      appCopyright: 'WS contributors',
      electronVersion: require('../package.json').devDependencies.electron,
      electronZipDir: process.env.WS_ELECTRON_ZIPS || undefined,
      download: { cacheRoot: path.join(privateRoot, 'build/electron-download') },
    });
    const target = path.join(root, 'dist', 'WS-Clean-' + version + '-' + Date.now());
    fs.cpSync(built, target, { recursive: true });
    for (const name of fs.readdirSync(runtimeRoot))
      fs.cpSync(path.join(runtimeRoot, name), path.join(target, 'runtime', name), {
        recursive: true,
      });
    for (const locale of fs.readdirSync(path.join(target, 'locales')))
      if (!['zh-CN.pak', 'en-US.pak'].includes(locale))
        fs.unlinkSync(path.join(target, 'locales', locale));
    fs.copyFileSync(path.join(built, 'LICENSE'), path.join(target, 'Electron.LICENSE'));
    // The root README links to WS's LICENSE; retain Electron's license under its own name.
    for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'licenses'])
      fs.cpSync(path.join(root, name), path.join(target, name), { recursive: true });
    fs.cpSync(path.join(root, 'docs'), path.join(target, 'docs'), { recursive: true });
    fs.copyFileSync(path.join(root, 'README.md'), path.join(target, 'README.md'));
    fs.writeFileSync(
      path.join(target, 'release.json'),
      JSON.stringify({
        version,
        privateRootDefault: 'WS-Private',
        clean: true,
        platform: 'win32-x64',
      }),
    );
    console.log(target);
  } finally {
    // Delete only the UUID directory created by this invocation; keep user data and old builds.
    if (
      process.env.WS_KEEP_BUILD_SCRATCH !== '1' &&
      path.dirname(scratch) === path.join(privateRoot, 'build') &&
      /^packager-[a-f0-9-]+$/.test(path.basename(scratch))
    )
      fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
