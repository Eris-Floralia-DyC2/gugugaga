const fs = require('node:fs');
const path = require('node:path');
module.exports = function notices(root) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  let text =
    '# Third-party notices\n\nWS original portions authorized by their rightsholders: Apache-2.0. Third-party code and assets retain their own terms; see NOTICE and docs/LICENSE_REVIEW.md.\n\nElectron ' +
    require(path.join(root, 'package.json')).devDependencies.electron +
    ' uses MIT; its original license is distributed as Electron.LICENSE. Chromium and bundled components: see LICENSES.chromium.html alongside WS.exe.\n\nDOMPurify is used under its Apache-2.0 option (the package offers MPL-2.0 OR Apache-2.0). Other dependencies retain their own license terms below.\n\n';
  for (const [key, entry] of Object.entries(lock.packages || {})) {
    if (!key || entry.dev || !fs.existsSync(path.join(root, key, 'package.json'))) continue;
    const dir = path.join(root, key),
      p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    text += `## ${p.name} ${p.version}\n\nLicense: ${p.license || entry.license || 'see bundled package'}\n\n`;
    const files = fs
      .readdirSync(dir)
      .filter(
        (f) =>
          /^(licen[cs]e|copying|notice)([.\-_]|$)/i.test(f) &&
          fs.statSync(path.join(dir, f)).isFile(),
      );
    for (const file of files)
      text += `### ${file}\n\n\`\`\`text\n${fs.readFileSync(path.join(dir, file), 'utf8')}\n\`\`\`\n\n`;
    if (!files.length)
      text += 'See the installed package metadata and upstream repository for its license.\n\n';
  }
  fs.writeFileSync(
    path.join(root, 'THIRD_PARTY_NOTICES.md'),
    text.replace(/[ \t]+$/gm, '').trimEnd() +
      '\n\n## Message processing runtime\n\nAdapted WeChat crypto, image parsing and read-only key scanners: 328336690/wechat-decrypt (MIT). WCDB key-cache compatibility layout: fanyuantaier/wechatauto-replica (Apache-2.0). Full licenses and modification notices: runtime/ws-worker/licenses. Python dependencies retain their own licenses, metadata, and notices in that directory. No ASR model is used by the current workflow. QQ optional resources retain GPL-3.0 and the NapCat Limited Redistribution License; see docs/QQ_THIRD_PARTY.md.\n',
  );
};
if (require.main === module) module.exports(path.resolve(__dirname, '..'));
