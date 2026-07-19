const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function findHelper(directory) {
  if (!fs.existsSync(directory)) return null;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const value = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === 'volyx-lens-vision-ocr' && value.includes(`${path.sep}Contents${path.sep}Resources${path.sep}native${path.sep}`)) return value;
    if (entry.isDirectory()) {
      const nested = findHelper(value);
      if (nested) return nested;
    }
  }
  return null;
}

if (process.platform !== 'darwin') {
  console.log('macOS Vision OCR package verification skipped on non-macOS.');
  process.exit(0);
}

const helper = findHelper(path.resolve(__dirname, '..', 'dist'));
if (!helper) throw new Error('Packaged macOS Vision OCR helper was not found.');
fs.accessSync(helper, fs.constants.X_OK);
const stat = fs.statSync(helper);
if (!stat.isFile() || (stat.mode & 0o002)) throw new Error('Packaged macOS Vision OCR helper permissions are unsafe.');
const result = spawnSync(helper, ['--self-test'], { encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024, env: { PATH: process.env.PATH || '' } });
if (result.status !== 0) throw new Error(`Packaged macOS Vision OCR helper self-test failed with exit code ${result.status}.`);
const payload = JSON.parse(String(result.stdout || '').trim());
if (payload.ok !== true || payload.engine !== 'macos-vision' || payload.version !== 1) throw new Error('Packaged macOS Vision OCR helper returned an invalid self-test payload.');
console.log(`Packaged macOS Vision OCR helper verified: ${path.relative(path.resolve(__dirname, '..'), helper)}`);
