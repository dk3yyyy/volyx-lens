#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const roots = ['main.js', 'preload.js', 'src', 'renderer', 'scripts', 'tests'];
const files = [];
function walk(target) {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) walk(path.join(target, name));
  } else if (target.endsWith('.js')) files.push(target);
}
for (const root of roots) if (fs.existsSync(root)) walk(root);
for (const file of files) require('node:child_process').execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
console.log(`Syntax checked ${files.length} JavaScript files.`);
