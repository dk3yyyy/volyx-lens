'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MAX_INDEXED_FILES = 5000;
const MAX_WORKSPACES = 20;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 8;
const MAX_SNIPPET_CHARS = 1400;
const MAX_WALK_DEPTH = 32;
const MAX_WALK_DIRECTORIES = 20000;
const INDEX_SCHEMA_VERSION = 1;

const INCLUDED_EXTENSIONS = new Set([
  '.c', '.cc', '.cfg', '.cpp', '.cs', '.css', '.cxx', '.go', '.h', '.hpp',
  '.html', '.ini', '.java', '.js', '.jsx', '.json', '.kt', '.md', '.mjs',
  '.php', '.properties', '.py', '.rb', '.rs', '.rst', '.scss', '.sh',
  '.sql', '.swift', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
  '.zsh',
]);

const SPECIAL_TEXT_FILES = new Set([
  'dockerfile', 'gemfile', 'makefile', 'procfile', 'rakefile', 'justfile',
  'brewfile', 'go.mod',
]);

const PRIVATE_DIRECTORIES = new Set([
  '.ssh', '.aws', '.docker', '.config', '.kube', '.gnupg', '.azure', '.gcloud',
  '.password-store', '.volyx-lens', 'library', 'application support', 'appdata',
]);

const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', '.next', '.nuxt', '.cache', '.idea', '.terraform',
  '.venv', '.build', 'build', 'coverage', 'dist', 'node_modules', 'out', 'pods',
  'target', 'vendor', 'venv', ...PRIVATE_DIRECTORIES,
]);

const SENSITIVE_FILE_NAMES = new Set([
  '.netrc', '.npmrc', '.pypirc', '.yarnrc', '.yarnrc.yml', 'credentials', 'credentials.json',
  'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_rsa', 'secrets', 'secrets.json',
  'npm-shrinkwrap.json', 'package-lock.json', 'packages.lock.json',
  'pnpm-lock.yaml', 'yarn.lock', 'cargo.lock', 'composer.lock', 'gemfile.lock',
  'pipfile.lock', 'poetry.lock', 'go.sum',
]);

function isExcludedName(name) {
  const lower = String(name || '').toLowerCase();
  return EXCLUDED_DIRECTORIES.has(lower)
    || lower.startsWith('.env')
    || SENSITIVE_FILE_NAMES.has(lower)
    || /(?:^|[._-])(?:secret|secrets|credential|credentials|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|id[_-](?:rsa|dsa|ecdsa|ed25519))(?:[._-]|$)/i.test(lower)
    || /\.(?:key|pem|p12|pfx|p7b|p7c|p8|der|lock)$/i.test(lower);
}

function isSupportedTextFile(name) {
  const lower = String(name || '').toLowerCase();
  return !isExcludedName(lower)
    && (INCLUDED_EXTENSIONS.has(path.extname(lower)) || SPECIAL_TEXT_FILES.has(lower));
}

function searchTerms(query) {
  return [...new Set(String(query || '').slice(0, 4000).toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) || [])]
    .slice(0, 16);
}

function foldWithMap(value) {
  const text = String(value || '');
  let folded = '';
  const map = [];
  for (let index = 0; index < text.length;) {
    const character = String.fromCodePoint(text.codePointAt(index));
    const normalized = character.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (let offset = 0; offset < normalized.length; offset += 1) map.push(index);
    folded += normalized;
    index += character.length;
  }
  return { folded, map };
}

function safeSnippet(content, terms) {
  const text = String(content || '');
  const { folded, map } = foldWithMap(text);
  const tokens = [...folded.matchAll(/[\p{L}\p{N}\p{Co}]+/gu)].map((match) => ({
    value: match[0],
    index: match.index,
  }));
  let bestMatch = -1;
  for (const term of terms) {
    const needle = String(term || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    const phrase = needle.match(/[\p{L}\p{N}\p{Co}]+/gu);
    if (!phrase) continue;
    for (let index = 0; index <= tokens.length - phrase.length; index += 1) {
      if (!phrase.every((token, offset) => tokens[index + offset].value === token)) continue;
      const found = tokens[index].index;
      if (bestMatch < 0 || found < bestMatch) bestMatch = found;
      break;
    }
  }
  const matchIndex = bestMatch < 0 ? 0 : bestMatch;
  const originalIndex = map[matchIndex] ?? Math.min(matchIndex, text.length);
  let start = Math.max(0, originalIndex - Math.floor(MAX_SNIPPET_CHARS / 3));
  let end = Math.min(text.length, start + MAX_SNIPPET_CHARS);
  if (end - start < MAX_SNIPPET_CHARS) start = Math.max(0, end - MAX_SNIPPET_CHARS);
  const snippet = text.slice(start, end);
  const lineStart = text.slice(0, start).split('\n').length;
  const lineEnd = lineStart + snippet.split('\n').length - 1;
  return { snippet, lineStart, lineEnd };
}

function isTextContent(buffer) {
  if (!buffer.length) return true;
  if (buffer.includes(0)) return false;
  const text = buffer.toString('utf8');
  const invalidControls = (text.match(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
  return invalidControls / text.length < 0.01;
}

function containsLikelySecret(text) {
  const value = String(text || '');
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/i.test(value)) return true;
  if (/\b(?:sk_(?:live|test)_[A-Za-z0-9]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|xox[pa]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{20,})\b/.test(value)) return true;
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|sk-(?:proj-|ant-api03-)?[A-Za-z0-9_-]{20,}|xoxb-[A-Za-z0-9-]{20,}|glpat-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/.test(value)) return true;
  if (/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(value)) return true;
  if (/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i.test(value)) return true;

  const assignment = /\b([A-Za-z][A-Za-z0-9_.-]*)\s*['"]?\s*[:=]\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s,;}\]]+))/g;
  let match;
  while ((match = assignment.exec(value)) !== null) {
    const name = match[1].replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    const parts = name.split(/[^a-z0-9]+/).filter(Boolean);
    const sensitiveName = parts.some((part) => ['secret', 'token', 'password', 'passwd'].includes(part))
      || parts.some((part, index) => ['api', 'private'].includes(part) && parts[index + 1] === 'key')
      || ['apikey', 'privatekey'].includes(parts.join(''));
    if (!sensitiveName) continue;
    const secret = (match[2] ?? match[3] ?? match[4]) || '';
    if (secret.length < 12) continue;
    if (/^(?:process\.env|import\.meta\.env|deno\.env|env(?:\.|\[)|os\.environ|getenv\s*\(|\$\{|<|your[_ -]|example|sample|test|mock|dummy|fake|change[_ -]?me|replace[_ -]?me|todo|tbd)/i.test(secret)) continue;
    return true;
  }
  return false;
}

async function readBoundedFile(fileHandle, maxBytes) {
  const readLimit = Math.max(1, Math.floor(maxBytes)) + 1;
  const buffer = Buffer.allocUnsafe(readLimit);
  let total = 0;
  while (total < readLimit) {
    const { bytesRead } = await fileHandle.read(buffer, total, readLimit - total, null);
    if (!bytesRead) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function createWorkspaceIndex({
  databasePath,
  maxFiles = MAX_INDEXED_FILES,
  maxFileBytes = MAX_FILE_BYTES,
  maxTotalBytes = MAX_TOTAL_BYTES,
  maxResults = MAX_SEARCH_RESULTS,
} = {}) {
  if (typeof databasePath !== 'string' || !databasePath.trim()) throw new TypeError('A workspace index database path is required.');
  const fileLimit = Number.isSafeInteger(maxFiles) && maxFiles > 0 ? maxFiles : MAX_INDEXED_FILES;
  const perFileLimit = Number.isSafeInteger(maxFileBytes) && maxFileBytes > 0 ? maxFileBytes : MAX_FILE_BYTES;
  const totalByteLimit = Number.isSafeInteger(maxTotalBytes) && maxTotalBytes > 0 ? maxTotalBytes : MAX_TOTAL_BYTES;
  const resultLimit = Number.isSafeInteger(maxResults) && maxResults > 0 ? Math.min(maxResults, MAX_SEARCH_RESULTS) : MAX_SEARCH_RESULTS;
  const resolvedDatabasePath = path.resolve(databasePath);

  fs.mkdirSync(path.dirname(resolvedDatabasePath), { recursive: true, mode: 0o700 });
  const protectedRoots = [fs.realpathSync(path.dirname(resolvedDatabasePath))];
  const database = new DatabaseSync(resolvedDatabasePath);
  database.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      root_path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      indexed_at INTEGER,
      index_complete INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS workspace_files (
      id INTEGER PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL,
      modified_at INTEGER NOT NULL,
      size INTEGER NOT NULL,
      UNIQUE(workspace_id, relative_path)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS workspace_content USING fts5(content);
  `);
  fs.chmodSync(resolvedDatabasePath, 0o600);
  const schemaVersion = Number(database.prepare('PRAGMA user_version').get().user_version) || 0;
  if (schemaVersion > INDEX_SCHEMA_VERSION) {
    throw new Error('The local workspace index was created by a newer version of Volyx Lens. Update the app before using workspace context.');
  }
  if (schemaVersion < INDEX_SCHEMA_VERSION) {
    database.exec(`
      BEGIN IMMEDIATE;
      DELETE FROM workspace_content;
      DELETE FROM workspace_files;
      UPDATE workspaces SET index_complete = 0, indexed_at = NULL;
      PRAGMA user_version = ${INDEX_SCHEMA_VERSION};
      COMMIT;
    `);
  }

  const workspaceById = database.prepare('SELECT id, root_path, name, enabled, indexed_at FROM workspaces WHERE id = ?');
  const fileByPath = database.prepare('SELECT id, modified_at, size FROM workspace_files WHERE workspace_id = ? AND relative_path = ?');
  const contentByFileId = database.prepare('SELECT 1 AS present FROM workspace_content WHERE rowid = ?');
  const activeRefreshes = new Set();
  let refreshQueue = Promise.resolve();
  let closeRequested = false;
  let closed = false;
  let closePromise = null;
  let closeResolver = null;

  function withTransaction(operation) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  function getWorkspace(id) {
    if (closed) throw new Error('The local workspace index is closed.');
    const workspace = workspaceById.get(String(id || ''));
    if (!workspace) throw new Error('The selected workspace is no longer available.');
    return workspace;
  }

  function list() {
    return database.prepare(`
      SELECT workspaces.id, workspaces.root_path, workspaces.name, workspaces.enabled,
        workspaces.indexed_at, workspaces.index_complete,
        (SELECT COUNT(*) FROM workspace_files WHERE workspace_files.workspace_id = workspaces.id) AS file_count
      FROM workspaces
      ORDER BY workspaces.name COLLATE NOCASE, workspaces.root_path
    `).all().map((workspace) => ({
      id: workspace.id,
      rootPath: workspace.root_path,
      name: workspace.name,
      enabled: workspace.enabled === 1,
      indexedAt: workspace.indexed_at,
      indexComplete: workspace.index_complete === 1,
      fileCount: Number(workspace.file_count) || 0,
    }));
  }

  function add(rootPath) {
    if (typeof rootPath !== 'string' || !rootPath.trim()) throw new Error('Select a workspace folder first.');
    const root = fs.realpathSync(rootPath);
    if (!fs.statSync(root).isDirectory()) throw new Error('The selected workspace is not a folder.');
    const rootName = path.basename(root).toLowerCase();
    const homeDirectory = path.resolve(os.homedir());
    if (root === homeDirectory || root === path.parse(root).root) {
      throw new Error('Choose a specific project folder, not your home folder or filesystem root.');
    }
    if (PRIVATE_DIRECTORIES.has(rootName)
        || protectedRoots.some((protectedRoot) => isWithinRoot(protectedRoot, root))) {
      throw new Error('This folder contains private application or credential data and cannot be indexed.');
    }
    const existing = database.prepare('SELECT id FROM workspaces WHERE root_path = ?').get(root);
    if (existing) return list().find((workspace) => workspace.id === existing.id);
    if (list().length >= MAX_WORKSPACES) throw new Error(`Volyx Lens supports up to ${MAX_WORKSPACES} indexed folders.`);
    const baseName = path.basename(root) || root;
    const usedNames = new Set(list().map((workspace) => workspace.name));
    let name = baseName;
    if (usedNames.has(name)) {
      const parentName = path.basename(path.dirname(root));
      name = parentName ? `${baseName} (${parentName})` : `${baseName} (2)`;
      let suffix = 2;
      while (usedNames.has(name)) name = `${baseName} (${parentName || 'workspace'}) ${suffix++}`;
    }
    const id = crypto.randomUUID();
    database.prepare('INSERT INTO workspaces (id, root_path, name, enabled) VALUES (?, ?, ?, 0)').run(id, root, name);
    return list().find((workspace) => workspace.id === id);
  }

  function setEnabled(id, enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Workspace enabled state must be a boolean.');
    getWorkspace(id);
    database.prepare('UPDATE workspaces SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, String(id));
    return list().find((workspace) => workspace.id === String(id));
  }

  function deleteFile(workspaceId, fileId) {
    database.prepare('DELETE FROM workspace_content WHERE rowid = ?').run(fileId);
    database.prepare('DELETE FROM workspace_files WHERE id = ? AND workspace_id = ?').run(fileId, workspaceId);
  }

  function finishClose() {
    if (!closed) {
      database.close();
      closed = true;
    }
    if (closeResolver) {
      closeResolver();
      closeResolver = null;
    }
  }

  function scheduleRefresh(key, operation) {
    if (closeRequested) throw new Error('The local workspace index is closing.');
    if (activeRefreshes.has(key)) throw new Error('This workspace is already being refreshed.');
    activeRefreshes.add(key);
    const task = refreshQueue.then(operation);
    refreshQueue = task.catch(() => {});
    return task.finally(() => {
      activeRefreshes.delete(key);
      if (closeRequested && activeRefreshes.size === 0) finishClose();
    });
  }

  async function refresh(id) {
    const key = String(id || '');
    return scheduleRefresh(key, () => refreshWorkspace(key));
  }

  async function refreshWorkspace(id) {
    const workspace = getWorkspace(id);
    database.prepare('UPDATE workspaces SET index_complete = 0 WHERE id = ?').run(workspace.id);
    const root = fs.realpathSync(workspace.root_path);
    if (root !== workspace.root_path || !fs.statSync(root).isDirectory()) throw new Error('The selected workspace folder is no longer available.');

    const seen = new Set();
    const pending = [{ directory: root, depth: 0 }];
    const result = {
      workspaceId: workspace.id,
      indexed: 0,
      updated: 0,
      unchanged: 0,
      removed: 0,
      skipped: 0,
      unreadableFiles: 0,
      unreadableDirectories: 0,
      incomplete: false,
    };
    const storedBytes = database.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM workspace_files').get();
    let totalBytes = Number(storedBytes.total) || 0;
    let consideredFiles = 0;
    let visitedDirectories = 0;

    while (pending.length) {
      const current = pending.pop();
      visitedDirectories += 1;
      if (visitedDirectories > MAX_WALK_DIRECTORIES) {
        result.incomplete = true;
        break;
      }
      let entries;
      try {
        const directoryStat = await fs.promises.lstat(current.directory);
        const resolvedDirectory = await fs.promises.realpath(current.directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !isWithinRoot(root, resolvedDirectory)) {
          result.incomplete = true;
          continue;
        }
        if (protectedRoots.some((protectedRoot) => isWithinRoot(protectedRoot, resolvedDirectory))) continue;
        entries = await fs.promises.readdir(current.directory, { withFileTypes: true });
      } catch {
        if (current.directory === root) throw new Error('The selected workspace folder could not be read.');
        result.unreadableDirectories += 1;
        result.incomplete = true;
        continue;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of entries) {
        if (entry.isSymbolicLink() || isExcludedName(entry.name)) continue;
        const absolutePath = path.join(current.directory, entry.name);
        if (entry.isDirectory()) {
          if (current.depth < MAX_WALK_DEPTH) pending.push({ directory: absolutePath, depth: current.depth + 1 });
          else result.incomplete = true;
          continue;
        }
        if (!entry.isFile() || !isSupportedTextFile(entry.name)) continue;

        consideredFiles += 1;
        if (consideredFiles > fileLimit) {
          result.incomplete = true;
          result.skipped += 1;
          pending.length = 0;
          break;
        }
        const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
        if (!relativePath || relativePath.startsWith('../') || path.isAbsolute(relativePath)) continue;

        let stat;
        try {
          stat = await fs.promises.lstat(absolutePath);
        } catch {
          result.unreadableFiles += 1;
          result.incomplete = true;
          continue;
        }
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        const previous = fileByPath.get(workspace.id, relativePath);
        const fileVersion = Math.trunc(Math.max(stat.mtimeMs, Number(stat.ctimeMs) || 0));
        if (previous && previous.modified_at === fileVersion && previous.size === stat.size && contentByFileId.get(previous.id)) {
          seen.add(relativePath);
          result.unchanged += 1;
          continue;
        }
        if (stat.size > perFileLimit) {
          result.skipped += 1;
          if (previous) {
            deleteFile(workspace.id, previous.id);
            totalBytes -= previous.size;
            result.removed += 1;
          }
          continue;
        }
        const previousSize = previous ? previous.size : 0;
        if (totalBytes - previousSize + stat.size > totalByteLimit) {
          result.skipped += 1;
          result.incomplete = true;
          if (previous) {
            deleteFile(workspace.id, previous.id);
            totalBytes -= previousSize;
            result.removed += 1;
          }
          pending.length = 0;
          break;
        }

        let buffer;
        let fileHandle;
        try {
          const noFollow = fs.constants.O_NOFOLLOW || 0;
          fileHandle = await fs.promises.open(absolutePath, fs.constants.O_RDONLY | noFollow);
          const openedStat = await fileHandle.stat();
          if (!openedStat.isFile() || openedStat.dev !== stat.dev || openedStat.ino !== stat.ino) {
            result.incomplete = true;
            continue;
          }
          buffer = await readBoundedFile(fileHandle, perFileLimit);
          const verifiedStat = await fileHandle.stat();
          const resolvedFile = await fs.promises.realpath(absolutePath);
          if (verifiedStat.size !== stat.size
            || Math.trunc(verifiedStat.mtimeMs) !== Math.trunc(stat.mtimeMs)
            || Math.trunc(Number(verifiedStat.ctimeMs) || 0) !== Math.trunc(Number(stat.ctimeMs) || 0)
            || !isWithinRoot(root, resolvedFile)) {
            result.incomplete = true;
            continue;
          }
        } catch {
          result.unreadableFiles += 1;
          result.incomplete = true;
          continue;
        } finally {
          if (fileHandle) await fileHandle.close();
        }
        if (buffer.length > perFileLimit || !isTextContent(buffer) || containsLikelySecret(buffer.toString('utf8'))) {
          result.skipped += 1;
          result.incomplete ||= buffer.length > perFileLimit;
          if (previous) {
            deleteFile(workspace.id, previous.id);
            totalBytes -= previousSize;
          }
          continue;
        }

        const content = buffer.toString('utf8');
        const relative = relativePath;
        let fileId;
        withTransaction(() => {
          if (previous) {
            fileId = previous.id;
            database.prepare('UPDATE workspace_files SET modified_at = ?, size = ? WHERE id = ?')
              .run(fileVersion, buffer.length, fileId);
            database.prepare('DELETE FROM workspace_content WHERE rowid = ?').run(fileId);
          } else {
            const inserted = database.prepare(`
              INSERT INTO workspace_files (workspace_id, relative_path, modified_at, size)
              VALUES (?, ?, ?, ?)
            `).run(workspace.id, relative, fileVersion, buffer.length);
            fileId = Number(inserted.lastInsertRowid);
          }
          database.prepare('INSERT INTO workspace_content (rowid, content) VALUES (?, ?)').run(fileId, content);
        });
        if (previous) result.updated += 1;
        else result.indexed += 1;
        seen.add(relativePath);
        totalBytes += buffer.length - previousSize;
      }
    }

    if (!result.incomplete) {
      const stored = database.prepare('SELECT id, relative_path, size FROM workspace_files WHERE workspace_id = ?').all(workspace.id);
      for (const file of stored) {
        if (seen.has(file.relative_path)) continue;
        deleteFile(workspace.id, file.id);
        totalBytes -= file.size;
        result.removed += 1;
      }
    }
    database.prepare('UPDATE workspaces SET indexed_at = ?, index_complete = ? WHERE id = ?')
      .run(Date.now(), result.incomplete ? 0 : 1, workspace.id);
    return { ...result, workspace: list().find((item) => item.id === workspace.id) };
  }

  async function rebuild(id) {
    const key = String(id || '');
    return scheduleRefresh(key, async () => {
      getWorkspace(key);
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare('DELETE FROM workspace_content WHERE rowid IN (SELECT id FROM workspace_files WHERE workspace_id = ?)').run(key);
        database.prepare('DELETE FROM workspace_files WHERE workspace_id = ?').run(key);
        database.prepare('UPDATE workspaces SET index_complete = 0 WHERE id = ?').run(key);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      return refreshWorkspace(key);
    });
  }

  function search(query, { limit = resultLimit } = {}) {
    const terms = searchTerms(query);
    if (!terms.length) return [];
    const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    const cappedLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, resultLimit) : resultLimit;
    const rows = database.prepare(`
      SELECT workspaces.id AS workspace_id, workspaces.name AS workspace_name,
        workspace_files.relative_path, workspace_content.content,
        bm25(workspace_content) AS score
      FROM workspace_content
      JOIN workspace_files ON workspace_files.id = workspace_content.rowid
      JOIN workspaces ON workspaces.id = workspace_files.workspace_id
      WHERE workspace_content MATCH ? AND workspaces.enabled = 1 AND workspaces.index_complete = 1
      ORDER BY score
      LIMIT ?
    `).all(match, cappedLimit);

    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      relativePath: row.relative_path,
      ...safeSnippet(row.content, terms),
    }));
  }

  function remove(id) {
    const key = String(id || '');
    if (activeRefreshes.has(key)) throw new Error('Wait for the workspace refresh to finish before removing it.');
    getWorkspace(key);
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare('DELETE FROM workspace_content WHERE rowid IN (SELECT id FROM workspace_files WHERE workspace_id = ?)').run(key);
      database.prepare('DELETE FROM workspace_files WHERE workspace_id = ?').run(key);
      database.prepare('DELETE FROM workspaces WHERE id = ?').run(key);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return { removed: true, workspaces: list() };
  }

  function close() {
    closeRequested = true;
    if (!closePromise) {
      closePromise = new Promise((resolve) => { closeResolver = resolve; });
      if (activeRefreshes.size === 0) finishClose();
    }
    return closePromise;
  }

  return { list, add, setEnabled, refresh, rebuild, search, remove, close };
}

module.exports = {
  createWorkspaceIndex,
  isExcludedName,
  isSupportedTextFile,
  readBoundedFile,
  safeSnippet,
  containsLikelySecret,
  searchTerms,
  MAX_INDEXED_FILES,
  MAX_WORKSPACES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  MAX_SEARCH_RESULTS,
};
