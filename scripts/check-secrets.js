#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' })
  .split(/\r?\n/).filter(Boolean)
  .filter((file) => /\.(js|json|md|html|yml|yaml|plist)$/.test(file))
  .filter((file) => !file.startsWith('dist/') && file !== 'package-lock.json');
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{24,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /Authorization\s*:\s*['"]Bearer\s+[A-Za-z0-9._-]{20,}['"]/i,
];
const findings = [];
for (const file of files) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  for (const pattern of patterns) if (pattern.test(text)) findings.push(`${file}: ${pattern}`);
}
if (findings.length) {
  console.error('Potential committed secrets found:\n' + findings.join('\n'));
  process.exit(1);
}
console.log(`Secret scan passed across ${files.length} text files.`);
