'use strict';
// Runs only synthetic DOM and temporary SQLite fixtures. Never starts Codex,
// reads its profile, connects to its debug endpoint, or downloads a browser.
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const python = process.env.CNCC_PYTHON || 'python';

try {require.resolve('playwright');}
catch {
  console.error('Playwright is missing. Run npm ci --ignore-scripts first.');
  process.exit(1);
}
const pythonCheck = spawnSync(python, ['-c',
  'import sys,sqlite3; assert sys.version_info >= (3,10), "Python 3.10 or newer is required"'],
  {cwd:root, windowsHide:true, encoding:'utf8'});
if (pythonCheck.error || pythonCheck.status !== 0) {
  console.error('Python 3.10+ with sqlite3 is required. Set CNCC_PYTHON or make python available on PATH.');
  if (pythonCheck.error) console.error(pythonCheck.error.message);
  if (pythonCheck.stderr) console.error(pythonCheck.stderr.trim());
  process.exit(1);
}

const fixtures = [
  ['test-nested-ui.cjs', false],
  ['test-cascade-actions.cjs', false],
  ['test-cascade-shortcut.cjs', false],
  ['test-event-index.cjs', true]
];
for (const [file, nodeTest] of fixtures) {
  console.log('\nRunning synthetic fixture: ' + file);
  const result = spawnSync(process.execPath,
    [...(nodeTest ? ['--test'] : []), path.join(root, 'tests', file)], {
      cwd:root, windowsHide:true, stdio:'inherit',
      env:{...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'1'}
    });
  if (result.error) console.error(result.error.message);
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
console.log('\nAll four synthetic runtime suites passed. No official app or profile was accessed.');
