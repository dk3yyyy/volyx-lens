const fs = require('node:fs');
const path = require('node:path');

const FILES = Object.freeze([
  { source: 'volyx-lens-data.json', destination: 'volyx-lens-data.json' },
  { source: 'personal-context.json', destination: 'personal-context.json' },
]);
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;

function hasSymlinkComponent(target) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      return true;
    }
  }
  return false;
}

function isCanonicalDirectory(directory) {
  try {
    if (hasSymlinkComponent(directory)) return false;
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    return fs.realpathSync.native(directory) === path.resolve(directory);
  } catch {
    return false;
  }
}

function copyRegularFileNoFollow(source, destination, maxBytes) {
  let sourceFd = null;
  let destinationFd = null;
  let destinationCreated = false;
  let complete = false;
  try {
    sourceFd = fs.openSync(source, fs.constants.O_RDONLY | NO_FOLLOW);
    const sourceStat = fs.fstatSync(sourceFd);
    if (!sourceStat.isFile() || sourceStat.size > maxBytes) return false;

    destinationFd = fs.openSync(
      destination,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    destinationCreated = true;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, sourceStat.size)));
    let position = 0;
    while (position < sourceStat.size) {
      const bytesRead = fs.readSync(sourceFd, buffer, 0, Math.min(buffer.length, sourceStat.size - position), position);
      if (!bytesRead) throw new Error('Legacy data ended before its validated size.');
      let written = 0;
      while (written < bytesRead) written += fs.writeSync(destinationFd, buffer, written, bytesRead - written);
      position += bytesRead;
    }
    fs.fchmodSync(destinationFd, 0o600);
    fs.fsyncSync(destinationFd);
    complete = true;
    return true;
  } catch {
    return false;
  } finally {
    if (sourceFd !== null) try { fs.closeSync(sourceFd); } catch {}
    if (destinationFd !== null) try { fs.closeSync(destinationFd); } catch {}
    if (destinationCreated && !complete && !hasSymlinkComponent(path.dirname(destination))) {
      try { fs.unlinkSync(destination); } catch {}
    }
  }
}

function migrateLegacyUserData({ legacyUserData, currentUserData, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!legacyUserData || !currentUserData) return { migrated: [] };
  const legacy = path.resolve(String(legacyUserData));
  const current = path.resolve(String(currentUserData));
  const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
  if (legacy === current || !isCanonicalDirectory(legacy) || hasSymlinkComponent(current)) return { migrated: [] };

  const migrated = [];
  for (const entry of FILES) {
    const source = path.join(legacy, entry.source);
    const destination = path.join(current, entry.destination);
    if (fs.existsSync(destination) || hasSymlinkComponent(source)) continue;
    try { fs.mkdirSync(current, { recursive: true, mode: 0o700 }); }
    catch { continue; }
    if (!isCanonicalDirectory(legacy) || !isCanonicalDirectory(current)) continue;
    if (!copyRegularFileNoFollow(source, destination, limit)) continue;
    if (!isCanonicalDirectory(legacy) || !isCanonicalDirectory(current)) {
      try { fs.unlinkSync(destination); } catch {}
      continue;
    }
    migrated.push(entry.destination);
  }
  return { migrated };
}

module.exports = { migrateLegacyUserData, DEFAULT_MAX_BYTES, hasSymlinkComponent };
