'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const skip = new Set(['.git', 'node_modules', '.local-test', 'dist']);
const blockedDirs = new Set(['data', 'runtime', 'logs', 'backups', 'profile', 'profiles', '.codex', 'sessions', 'archived_sessions']);
const blockedNames = /^(?:auth(?:\..*)?\.json|credentials.*|tokens.*|relations\.json|(?:native-)?runtime-status\.json|module-state\.json|start-status\.json|ui-preferences\.json|runtime-options\.json|stop-request.*\.json|deployment\.json|release\.json|disabled\.json|codex\.ico|\.cncc-(?:install|data)\.json)$/i;
const blockedExt = /\.(?:db(?:-.*)?|sqlite(?:3)?(?:-.*)?|lnk|log)$/i;
const allowedRoots = new Set(['src', 'scripts', 'tests', 'docs', '.github', '.agents']);
const allowedFiles = new Set(['.gitignore', 'package.json', 'package-lock.json', 'plugin.json', 'mcp.json', 'README.md', 'README.zh-CN.md', 'NOTICE.md', 'LICENSE', 'LICENSE.md', 'runtime-manifest.json', 'CONTRIBUTING.md']);
const findings = [];
let checked = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replaceAll(path.sep, '/');
    if(rel.startsWith('.agents/')&&!['.agents/plugins','.agents/plugins/marketplace.json'].includes(rel)){findings.push(`${rel}: unreviewed agent metadata`);continue;}
    if (entry.isSymbolicLink()) { findings.push(`${rel}: symbolic links are excluded`); continue; }
    if (entry.isDirectory()) {
      if (blockedDirs.has(entry.name.toLowerCase())) { findings.push(`${rel}: local/private directory`); continue; }
      if (dir === root && !allowedRoots.has(entry.name)) { findings.push(`${rel}: unreviewed top-level directory`); continue; }
      walk(full); continue;
    }
    if (dir === root && !allowedFiles.has(entry.name)) findings.push(`${rel}: unreviewed top-level file`);
    if (blockedNames.test(entry.name) || blockedExt.test(entry.name) || /(?:acceptance|readback).*\.json$/i.test(entry.name)) findings.push(`${rel}: local/private or official file`);
    const content = fs.readFileSync(full);
    checked++;
    if (content.length > 2 * 1024 * 1024 || content.includes(0)) { findings.push(`${rel}: binary or unusually large file needs review`); continue; }
    const text = content.toString('utf8');
    if (/[A-Z]:[\\/]Users[\\/][^\s"'<>]+/i.test(text)) findings.push(`${rel}: user-specific absolute path`);
    if (/[.]cache[\\/]codex-runtimes|codex-primary-runtime[\\/]dependencies/.test(text)) findings.push(`${rel}: official bundled runtime dependency`);
    if (/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b|(?:Bearer\s+)[A-Za-z0-9._-]{24,}/.test(text)) findings.push(`${rel}: possible credential`);
  }
}
walk(root);
if (findings.length) {
  console.error(findings.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Release file audit passed (${checked} files). Review source rights and personal chat data before publishing.`);
}
