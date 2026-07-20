const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function findHelper(directory, name) {
  if (!fs.existsSync(directory)) return null;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const value = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === name && value.includes(`${path.sep}Contents${path.sep}Resources${path.sep}native${path.sep}`)) return value;
    if (entry.isDirectory()) {
      const nested = findHelper(value, name);
      if (nested) return nested;
    }
  }
  return null;
}

if (process.platform !== 'darwin') {
  console.log('macOS native helper package verification skipped on non-macOS.');
  process.exit(0);
}

const root = path.resolve(__dirname, '..');
const checks = [
  { name: 'volyx-lens-vision-ocr', validate: (p) => p.ok === true && p.engine === 'macos-vision' && p.version === 1 },
  { name: 'volyx-lens-system-audio', validate: (p) => p.ok === true && p.engine === 'ScreenCaptureKit' && p.protocol === 1 && p.sampleRate === 24000 && p.channels === 1 && p.frameSamples === 480 },
];
for (const check of checks) {
  const helper = findHelper(path.join(root, 'dist'), check.name);
  if (!helper) throw new Error(`Packaged macOS helper was not found: ${check.name}.`);
  fs.accessSync(helper, fs.constants.X_OK);
  const stat = fs.statSync(helper);
  if (!stat.isFile() || (stat.mode & 0o002)) throw new Error(`Packaged macOS helper permissions are unsafe: ${check.name}.`);
  const result = spawnSync(helper, ['--self-test'], { encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024, env: { ...process.env, PATH: process.env.PATH || '/usr/bin:/bin' } });
  if (result.status !== 0) throw new Error(`Packaged macOS helper self-test failed: ${check.name} (exit ${result.status}).`);
  const payload = JSON.parse(String(result.stdout || '').trim());
  if (!check.validate(payload)) throw new Error(`Packaged macOS helper returned an invalid self-test payload: ${check.name}.`);
  console.log(`Packaged macOS helper verified: ${path.relative(root, helper)}`);
}
