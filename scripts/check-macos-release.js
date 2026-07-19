const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const entitlements = fs.readFileSync(path.join(root, 'build', 'entitlements.mac.plist'), 'utf8');
const errors = [];
const mac = (pkg.build && pkg.build.mac) || {};

if (!pkg.build || !pkg.build.appId) errors.push('build.appId is required.');
if (mac.hardenedRuntime !== true) errors.push('mac.hardenedRuntime must be true.');
if (mac.notarize !== true) errors.push('mac.notarize must be true for release builds.');
if (!mac.entitlements || !fs.existsSync(path.join(root, mac.entitlements))) errors.push('mac.entitlements must reference an existing file.');
for (const key of ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory']) {
  if (!entitlements.includes(`<key>${key}</key>`)) errors.push(`Missing entitlement: ${key}`);
}

const requireCredentials = process.argv.includes('--require-credentials');
if (requireCredentials) {
  const hasCertificate = !!process.env.CSC_LINK;
  const hasNotaryApiKey = !!(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER);
  const hasAppleId = !!(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);
  if (!hasCertificate) errors.push('CSC_LINK is required for a signed release.');
  if (!hasNotaryApiKey && !hasAppleId) errors.push('Provide either App Store Connect API-key variables or Apple ID notarization variables.');
}

if (errors.length) {
  for (const error of errors) console.error(`release-check: ${error}`);
  process.exit(1);
}
console.log(`macOS release configuration is ready${requireCredentials ? ' and required credential variables are present' : ' (credentials not inspected)'}.`);
