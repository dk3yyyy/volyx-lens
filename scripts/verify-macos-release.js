const fs = require('fs');
const { spawnSync } = require('child_process');

if (process.platform !== 'darwin') {
  console.error('macOS release verification must run on a physical or hosted Mac.');
  process.exit(1);
}
const appPath = process.argv[2];
if (!appPath || !appPath.endsWith('.app') || !fs.existsSync(appPath)) {
  console.error('Usage: node scripts/verify-macos-release.js "/absolute/path/to/Volyx Lens.app"');
  process.exit(1);
}
const checks = [
  ['codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]],
  ['spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath]],
  ['xcrun', ['stapler', 'validate', appPath]],
];
for (const [command, args] of checks) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('macOS signature, Gatekeeper assessment, and notarization staple validated.');
