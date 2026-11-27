'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const {
  createWorkspaceIndex,
  containsLikelySecret,
  isExcludedName,
  isSupportedTextFile,
  readBoundedFile,
  safeSnippet,
} = require('../src/workspace-index');

const roots = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-workspace-index-'));
  roots.push(directory);
  return directory;
}

function write(directory, relativePath, content) {
  const file = path.join(directory, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function createIndex(directory, options = {}) {
  return createWorkspaceIndex({ databasePath: path.join(directory, 'user-data', 'workspace-index.sqlite'), ...options });
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

test('workspace index excludes secret, generated, unsupported, and symlinked content', async (t) => {
  const directory = temporaryDirectory();
  const root = path.join(directory, 'project');
  const outside = path.join(directory, 'outside');
  const fakeApiToken = ['sk', '-', 'a'.repeat(28)].join('');
  const privateKeyMarker = ['-----BEGIN RSA ', 'PRIVATE KEY-----'].join('');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  write(root, 'src/auth.js', 'export function authenticate() {\n  return API_TOKEN;\n}\n');
  write(root, 'README.md', '# Authentication\nUse the auth module.\n');
  write(root, 'src/config.ts', `const API_KEY = "${fakeApiToken}";\n`);
  write(root, 'docs/notes.txt', `${privateKeyMarker}\nprivate bytes\n`);
  write(root, '.env.local', 'API_TOKEN=private\n');
  write(root, 'id_rsa', 'private key data\n');
  write(root, 'node_modules/dependency/index.js', 'do not index\n');
  write(root, 'image.png', Buffer.from([0, 1, 2, 3]));
  write(outside, 'secret.md', 'outside the workspace\n');
  try {
    fs.symlinkSync(outside, path.join(root, 'external'), 'dir');
  } catch (error) {
    t.skip(`symlink creation unavailable: ${error.message}`);
    return;
  }

  const index = createIndex(directory);
  try {
    const workspace = index.add(root);
    const result = await index.refresh(workspace.id);

    assert.equal(result.indexed, 2);
    assert.equal(result.skipped, 2);
    assert.equal(result.incomplete, false);
    assert.deepEqual(index.list().map(({ fileCount }) => fileCount), [2]);
    assert.equal(index.search('API_TOKEN').length, 0, 'workspaces default to not being used in answers');

    index.setEnabled(workspace.id, true);
    const [match] = index.search('API_TOKEN');
    assert.equal(match.relativePath, 'src/auth.js');
    assert.equal(match.lineStart, 1);
    assert.match(match.snippet, /API_TOKEN/);
    assert.equal(index.search('outside workspace').length, 0);
  } finally {
    index.close();
  }
});

test('refresh updates changed files and removes deleted files without rebuilding unchanged rows', async () => {
  const directory = temporaryDirectory();
  const root = path.join(directory, 'project');
  fs.mkdirSync(root);
  const authFile = write(root, 'src/auth.ts', 'const releaseMarker = "retiredmark";\n');
  const readmeFile = write(root, 'README.md', 'Project setup notes.\n');
  const index = createIndex(directory);
  try {
    const workspace = index.add(root);
    const first = await index.refresh(workspace.id);
    assert.equal(first.indexed, 2);

    const unchanged = await index.refresh(workspace.id);
    assert.equal(unchanged.unchanged, 2);
    assert.equal(unchanged.updated, 0);

    write(root, 'src/auth.ts', 'const releaseMarker = "currentmark-and-longer";\n');
    fs.rmSync(readmeFile);
    const refreshed = await index.refresh(workspace.id);
    assert.equal(refreshed.updated, 1);
    assert.equal(refreshed.removed, 1);

    index.setEnabled(workspace.id, true);
    assert.equal(index.search('retiredmark').length, 0);
    assert.equal(index.search('currentmark').length, 1);
    assert.equal(fs.existsSync(authFile), true);

    const rebuilt = await index.rebuild(workspace.id);
    assert.equal(rebuilt.indexed, 1);
    assert.equal(rebuilt.updated, 0);
    assert.equal(rebuilt.workspace.indexComplete, true);
    assert.equal(index.search('currentmark').length, 1);
  } finally {
    index.close();
  }
});

test('refresh repairs metadata rows whose FTS content is missing', async () => {
  const directory = temporaryDirectory();
  const root = path.join(directory, 'project');
  fs.mkdirSync(root);
  write(root, 'README.md', 'restored searchable marker\n');
  const databasePath = path.join(directory, 'user-data', 'workspace-index.sqlite');
  const first = createWorkspaceIndex({ databasePath });
  const workspace = first.add(root);
  await first.refresh(workspace.id);
  first.setEnabled(workspace.id, true);
  first.close();

  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(databasePath);
  raw.exec('DELETE FROM workspace_content; UPDATE workspaces SET index_complete = 0;');
  raw.close();

  const index = createWorkspaceIndex({ databasePath });
  try {
    assert.equal(index.search('restored searchable').length, 0);
    const result = await index.refresh(workspace.id);
    assert.equal(result.indexed, 0);
    assert.equal(result.unchanged, 0);
    assert.equal(result.updated, 1);
    assert.equal(result.workspace.indexComplete, true);
    assert.equal(index.search('restored searchable').length, 1);
  } finally {
    index.close();
  }
});

test('refresh rolls back a file replacement when the FTS write fails', async (t) => {
  const directory = temporaryDirectory();
  const root = path.join(directory, 'project');
  fs.mkdirSync(root);
  write(root, 'README.md', 'const marker = "oldmarker";\n');
  const databasePath = path.join(directory, 'user-data', 'workspace-index.sqlite');
  const index = createWorkspaceIndex({ databasePath });
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(databasePath);
  const readState = () => {
    const file = raw.prepare('SELECT id, modified_at, size FROM workspace_files').get();
    const content = raw.prepare('SELECT content FROM workspace_content WHERE rowid = ?').get(file.id);
    return { ...file, content: content ? content.content : null };
  };
  try {
    const workspace = index.add(root);
    await index.refresh(workspace.id);
    index.setEnabled(workspace.id, true);
    const before = readState();
    write(root, 'README.md', 'const marker = "newmarker";\n');

    const originalPrepare = DatabaseSync.prototype.prepare;
    const prepareMock = t.mock.method(DatabaseSync.prototype, 'prepare', function prepare(sql) {
      if (/INSERT INTO workspace_content/i.test(sql)) {
        return { run() { throw new Error('simulated FTS write failure'); } };
      }
      return originalPrepare.call(this, sql);
    });
    await assert.rejects(index.refresh(workspace.id), /simulated FTS write failure/);
    prepareMock.mock.restore();

    assert.deepEqual(readState(), before);
    const retried = await index.refresh(workspace.id);
    assert.equal(retried.updated, 1);
    assert.equal(index.search('oldmarker').length, 0);
    assert.equal(index.search('newmarker').length, 1);
  } finally {
    raw.close();
    index.close();
  }
});

test('refresh skips oversized files while keeping the remaining complete index usable', async () => {
  const directory = temporaryDirectory();
  const root = path.join(directory, 'project');
  fs.mkdirSync(root);
  write(root, 'README.md', 'safe marker content\n');
  const index = createIndex(directory, { maxFileBytes: 32 });
  try {
    const workspace = index.add(root);
    const first = await index.refresh(workspace.id);
    assert.equal(first.indexed, 1);
    assert.equal(first.workspace.indexComplete, true);
    index.setEnabled(workspace.id, true);
    assert.equal(index.search('safe marker').length, 1);

    write(root, 'large.md', 'x'.repeat(100));
    const result = await index.refresh(workspace.id);
    assert.equal(result.skipped, 1);
    assert.equal(result.incomplete, false);
    assert.equal(result.workspace.indexComplete, true);
    assert.equal(index.search('safe marker').length, 1);
  } finally {
    index.close();
  }
});

test('refresh detects same-size rewrites even when the old mtime is restored', async () => {
  const directory = temporaryDirectory();
  const root = path.join(directory, 'project');
  fs.mkdirSync(root);
  const file = write(root, 'src/value.ts', 'const value = "before";\n');
  const index = createIndex(directory);
  try {
    const workspace = index.add(root);
    await index.refresh(workspace.id);
    const old = fs.statSync(file);
    write(root, 'src/value.ts', 'const value = "after!";\n');
    fs.utimesSync(file, old.atime / 1000, old.mtime / 1000);
    const refreshed = await index.refresh(workspace.id);
    assert.equal(refreshed.updated, 1);
    index.setEnabled(workspace.id, true);
    assert.equal(index.search('before').length, 0);
    assert.equal(index.search('after').length, 1);
  } finally {
    index.close();
  }
});

test('workspace byte budget applies across all selected folders', async () => {
  const directory = temporaryDirectory();
  const firstRoot = path.join(directory, 'first');
  const secondRoot = path.join(directory, 'second');
  fs.mkdirSync(firstRoot);
  fs.mkdirSync(secondRoot);
  write(firstRoot, 'README.md', 'firstmarker\n');
  write(secondRoot, 'README.md', 'secondmarker\n');
  const index = createIndex(directory, { maxTotalBytes: 20 });
  try {
    const first = index.add(firstRoot);
    await index.refresh(first.id);
    index.setEnabled(first.id, true);

    const second = index.add(secondRoot);
    const result = await index.refresh(second.id);
    assert.equal(result.incomplete, true);
    assert.equal(result.workspace.indexComplete, false);
    assert.equal(index.search('firstmarker').length, 1);
    assert.equal(index.search('secondmarker').length, 0);
  } finally {
    index.close();
  }
});

test('incomplete refresh counts retained rows and reclaims only rows whose files are confirmed missing', async () => {
  const directory = temporaryDirectory();
  const root = path.join(directory, 'project');
  fs.mkdirSync(root);
  write(root, 'b.md', 'bmarker\n');
  const staleFile = write(root, 'd.md', 'dmarker\n');
  const databasePath = path.join(directory, 'user-data', 'workspace-index.sqlite');
  const index = createWorkspaceIndex({ databasePath, maxFiles: 2, maxTotalBytes: 16 });
  const storedFiles = () => {
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(databasePath);
    try {
      return raw.prepare(`
        SELECT workspace_files.relative_path, workspace_files.size,
          workspace_content.content IS NOT NULL AS has_content
        FROM workspace_files
        LEFT JOIN workspace_content ON workspace_content.rowid = workspace_files.id
        ORDER BY workspace_files.relative_path
      `).all().map((file) => ({
        relative_path: file.relative_path,
        size: file.size,
        has_content: file.has_content,
      }));
    } finally {
      raw.close();
    }
  };
  try {
    const workspace = index.add(root);
    const first = await index.refresh(workspace.id);
    assert.equal(first.workspace.indexComplete, true);
    assert.equal(first.workspace.fileCount, 2);
    assert.equal(storedFiles().reduce((total, file) => total + file.size, 0), 16);

    fs.rmSync(staleFile);
    const firstNewFile = write(root, 'a.md', 'amarker\n');
    const secondNewFile = write(root, 'e.md', 'emarker\n');
    const incomplete = await index.refresh(workspace.id);
    assert.equal(incomplete.incomplete, true);
    assert.equal(incomplete.skipped, 1);
    assert.equal(incomplete.removed, 1, 'a row whose file is confirmed missing is reclaimed; merely unvisited rows are not');
    assert.equal(incomplete.workspace.fileCount, 2);
    assert.deepEqual(storedFiles(), [
      { relative_path: 'a.md', size: 8, has_content: 1 },
      { relative_path: 'b.md', size: 8, has_content: 1 },
    ]);
    assert.ok(storedFiles().reduce((total, file) => total + file.size, 0) <= 16);

    fs.rmSync(firstNewFile);
    fs.rmSync(secondNewFile);
    const complete = await index.refresh(workspace.id);
    assert.equal(complete.incomplete, false);
    assert.equal(complete.unchanged, 1);
    assert.equal(complete.removed, 1);
    assert.equal(complete.workspace.fileCount, 1);
    assert.deepEqual(storedFiles(), [{ relative_path: 'b.md', size: 8, has_content: 1 }]);
    index.setEnabled(workspace.id, true);
    assert.equal(index.search('bmarker').length, 1);
    assert.equal(index.search('dmarker').length, 0);
  } finally {
    index.close();
  }
});

test('concurrent workspace refreshes cannot exceed the global byte budget', async () => {
  const directory = temporaryDirectory();
  const firstRoot = path.join(directory, 'first');
  const secondRoot = path.join(directory, 'second');
  fs.mkdirSync(firstRoot);
  fs.mkdirSync(secondRoot);
  write(firstRoot, 'README.md', 'firstmarker-content\n');
  write(secondRoot, 'README.md', 'secondmarker-content\n');
  const index = createIndex(directory, { maxTotalBytes: 24 });
  try {
    const first = index.add(firstRoot);
    const second = index.add(secondRoot);
    const results = await Promise.allSettled([index.refresh(first.id), index.refresh(second.id)]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'fulfilled');
    const completed = results.filter((result) => result.value.workspace.indexComplete);
    assert.equal(completed.length, 1);
    assert.equal(index.list().reduce((total, workspace) => total + workspace.fileCount, 0), 1);
  } finally {
    index.close();
  }
});

test('close waits for active refresh writes before resolving', async () => {
  const directory = temporaryDirectory();
  const root = path.join(directory, 'project');
  fs.mkdirSync(root);
  write(root, 'README.md', 'shutdown refresh marker\n');
  const databasePath = path.join(directory, 'user-data', 'workspace-index.sqlite');
  const index = createWorkspaceIndex({ databasePath });
  let refreshing;
  try {
    const workspace = index.add(root);
    index.setEnabled(workspace.id, true);
    refreshing = index.refresh(workspace.id);
    const closing = index.close();
    assert.equal(typeof closing?.then, 'function');
    await closing;
    const result = await refreshing;
    assert.equal(result.workspace.indexComplete, true);

    const reopened = createWorkspaceIndex({ databasePath });
    try {
      assert.equal(reopened.list()[0].fileCount, 1);
      assert.equal(reopened.list()[0].indexComplete, true);
      assert.equal(reopened.search('shutdown refresh').length, 1);
    } finally {
      reopened.close();
    }
  } finally {
    index.close();
    if (refreshing) await refreshing.catch(() => {});
  }
});

test('removing a workspace deletes its indexed documents and metadata', async () => {
  const directory = temporaryDirectory();
  const root = path.join(directory, 'project');
  fs.mkdirSync(root);
  write(root, 'README.md', 'workspace removal test phrase\n');
  const index = createIndex(directory);
  try {
    const workspace = index.add(root);
    await index.refresh(workspace.id);
    index.setEnabled(workspace.id, true);
    assert.equal(index.search('removal test').length, 1);

    assert.deepEqual(index.remove(workspace.id), { removed: true, workspaces: [] });
    assert.equal(index.search('removal test').length, 0);
  } finally {
    index.close();
  }
});

test('credential detection catches common assignment, token, URL, and private-key formats', () => {
  const fakeValue = 'a'.repeat(32);
  const npmToken = ['npm_', 'n'.repeat(36)].join('');
  const projectToken = ['sk-proj-', 'p'.repeat(36)].join('');
  const anthropicToken = ['sk-ant-api03-', 'a'.repeat(36)].join('');
  const slackToken = ['xoxb-', '123456789012-', 's'.repeat(24)].join('');
  const gitlabToken = ['glpat-', 'g'.repeat(36)].join('');
  const stripeLiveToken = ['sk_live_', 'stripecredential', 's'.repeat(24)].join('');
  const stripeTestToken = ['sk_test_', 'stripecredential', 't'.repeat(24)].join('');
  const sendgridToken = ['SG.', 'sendgridcredential', 's'.repeat(16), '.', 'sendgridtail', 's'.repeat(24)].join('');
  const slackUserToken = ['xoxp-', '123456789012-', 'slackusercredential', 's'.repeat(24)].join('');
  const slackAppToken = ['xoxa-', '2-', '123456789012-', 'slackappcredential', 'a'.repeat(24)].join('');
  const googleToken = ['AIza', 'googlecredential', 'g'.repeat(30)].join('');
  const huggingFaceToken = ['hf_', 'huggingfacecredential', 'h'.repeat(24)].join('');
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature-value-123';
  for (const content of [
    `api_key: ${fakeValue}`,
    `export API_KEY=${fakeValue}`,
    `const token = "${fakeValue}";`,
    `npmAuthToken: "${fakeValue}"`,
    `const githubToken = "${fakeValue}";`,
    `AWS_SECRET_ACCESS_KEY=${fakeValue}`,
    `secretAccessKey: "${fakeValue}"`,
    `literal credential ${npmToken}`,
    `literal credential ${projectToken}`,
    `literal credential ${anthropicToken}`,
    `literal credential ${slackToken}`,
    `literal credential ${gitlabToken}`,
    `literal credential ${stripeLiveToken}`,
    `literal credential ${stripeTestToken}`,
    `literal credential ${sendgridToken}`,
    `literal credential ${slackUserToken}`,
    `literal credential ${slackAppToken}`,
    `literal credential ${googleToken}`,
    `literal credential ${huggingFaceToken}`,
    'password: "correct horse battery staple"',
    `Authorization: Bearer ${jwt}`,
    'postgres://alice:supersecret@example.com/database',
    '-----BEGIN ENCRYPTED PRIVATE KEY-----',
    '-----BEGIN PGP PRIVATE KEY BLOCK-----',
  ]) {
    assert.equal(containsLikelySecret(content), true, content);
  }
  for (const content of [
    'const apiKey = process.env.API_KEY;',
    'const npmAuthToken = process.env.NPM_TOKEN;',
    'AWS_SECRET_ACCESS_KEY=process.env.AWS_SECRET_ACCESS_KEY',
    'secretAccessKey: process.env.SECRET_ACCESS_KEY',
    'password: "${DATABASE_PASSWORD}"',
    'token = "your-token-here"',
    'client_secret: example-value',
    'secretAccessKey: "<secret-access-key>"',
    'stripe_secret_key = process.env.STRIPE_SECRET_KEY',
    'sendgrid_api_key = "${SENDGRID_API_KEY}"',
    'slack_bot_token = os.environ["SLACK_BOT_TOKEN"]',
    'google_api_key = getenv("GOOGLE_API_KEY")',
    'huggingface_token = Deno.env.get("HF_TOKEN")',
  ]) {
    assert.equal(containsLikelySecret(content), false, content);
  }
});

test('private and generated directories are excluded from workspace indexing', () => {
  for (const name of ['.ssh', '.aws', '.docker', '.config', '.kube', '.gnupg', 'Library', 'Application Support', 'AppData', '.venv', 'venv', '.build', 'Pods']) {
    assert.equal(isExcludedName(name), true, name);
  }
  assert.equal(isSupportedTextFile('npm-shrinkwrap.json'), false);
  assert.equal(isSupportedTextFile('packages.lock.json'), false);
  assert.equal(isSupportedTextFile('.yarnrc.yml'), false);
  assert.equal(isSupportedTextFile('.yarnrc'), false);
});

test('workspace refresh skips credential config, prefixed assignments, and literal npm tokens', async () => {
  const directory = temporaryDirectory();
  const root = path.join(directory, 'project');
  fs.mkdirSync(root);
  const yarnValue = 'a'.repeat(32);
  const githubValue = 'g'.repeat(32);
  const npmToken = ['npm_', 'n'.repeat(36)].join('');
  write(root, 'README.md', 'safe public marker\n');
  write(root, '.yarnrc.yml', `npmAuthToken: "${yarnValue}"\n`);
  write(root, 'auth.js', `const githubToken = "${githubValue}";\n`);
  write(root, 'token.txt', `literal credential ${npmToken}\n`);

  const index = createIndex(directory);
  try {
    const workspace = index.add(root);
    const result = await index.refresh(workspace.id);
    assert.equal(result.indexed, 1);
    assert.equal(result.skipped, 2);
    assert.equal(result.workspace.indexComplete, true);
    assert.deepEqual(index.list().map(({ fileCount }) => fileCount), [1]);
    index.setEnabled(workspace.id, true);
    assert.equal(index.search('public marker').length, 1);
    assert.equal(index.search(yarnValue).length, 0);
    assert.equal(index.search(githubValue).length, 0);
    assert.equal(index.search(npmToken).length, 0);
  } finally {
    index.close();
  }
});

test('workspace refresh skips prefixed provider tokens and compound secret assignments', async () => {
  const directory = temporaryDirectory();
  const root = path.join(directory, 'project');
  fs.mkdirSync(root);
  const projectToken = ['sk-proj-', 'projectcredential', 'p'.repeat(24)].join('');
  const anthropicToken = ['sk-ant-api03-', 'anthropiccredential', 'a'.repeat(24)].join('');
  const slackToken = ['xoxb-', '123456789012-', 'slackcredential', 's'.repeat(16)].join('');
  const gitlabToken = ['glpat-', 'gitlabcredential', 'g'.repeat(24)].join('');
  const awsSecret = `awscredential${'a'.repeat(24)}`;
  const camelSecret = `camelcredential${'c'.repeat(24)}`;
  write(root, 'README.md', 'safe public marker\n');
  write(root, 'openai.txt', `literal credential ${projectToken}\n`);
  write(root, 'anthropic.txt', `literal credential ${anthropicToken}\n`);
  write(root, 'slack.txt', `literal credential ${slackToken}\n`);
  write(root, 'gitlab.txt', `literal credential ${gitlabToken}\n`);
  write(root, 'aws-config.txt', `AWS_SECRET_ACCESS_KEY=${awsSecret}\n`);
  write(root, 'camel-config.txt', `secretAccessKey: "${camelSecret}"\n`);
  write(root, 'environment.js', [
    'export const environmentMarker = true;',
    'const apiKey = process.env.API_KEY;',
    'const secretAccessKey = process.env.SECRET_ACCESS_KEY;',
    '',
  ].join('\n'));
  write(root, 'environment.sh', 'export AWS_SECRET_ACCESS_KEY=process.env.AWS_SECRET_ACCESS_KEY\n');
  write(root, 'placeholders.yaml', [
    'placeholderMarker: true',
    'AWS_SECRET_ACCESS_KEY: "${AWS_SECRET_ACCESS_KEY}"',
    'secretAccessKey: "<secret-access-key>"',
    '',
  ].join('\n'));

  const index = createIndex(directory);
  try {
    const workspace = index.add(root);
    const result = await index.refresh(workspace.id);
    assert.equal(result.indexed, 4);
    assert.equal(result.skipped, 6);
    assert.equal(result.workspace.indexComplete, true);
    assert.deepEqual(index.list().map(({ fileCount }) => fileCount), [4]);
    index.setEnabled(workspace.id, true);
    assert.equal(index.search('public marker').length, 1);
    assert.equal(index.search('environmentMarker').length, 1);
    assert.equal(index.search('placeholderMarker').length, 1);
    for (const secret of [projectToken, anthropicToken, slackToken, gitlabToken, awsSecret, camelSecret]) {
      assert.equal(index.search(secret).length, 0, secret);
    }
  } finally {
    index.close();
  }
});

test('workspace refresh and enabled search exclude notes containing residual provider credential formats', async () => {
  const directory = temporaryDirectory();
  const root = path.join(directory, 'project');
  fs.mkdirSync(root);
  const tokens = [
    ['sk_live_', 'stripecredential', 's'.repeat(24)].join(''),
    ['sk_test_', 'stripecredential', 't'.repeat(24)].join(''),
    ['SG.', 'sendgridcredential', 's'.repeat(16), '.', 'sendgridtail', 's'.repeat(24)].join(''),
    ['xoxp-', '123456789012-', 'slackusercredential', 's'.repeat(24)].join(''),
    ['xoxa-', '2-', '123456789012-', 'slackappcredential', 'a'.repeat(24)].join(''),
    ['AIza', 'googlecredential', 'g'.repeat(30)].join(''),
    ['hf_', 'huggingfacecredential', 'h'.repeat(24)].join(''),
  ];
  write(root, 'notes.txt', `innocuousnotesmarker\n${tokens.map((token) => `literal credential ${token}`).join('\n')}\n`);

  const index = createIndex(directory);
  try {
    const workspace = index.add(root);
    const result = await index.refresh(workspace.id);
    assert.equal(result.indexed, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.workspace.indexComplete, true);
    assert.deepEqual(index.list().map(({ fileCount }) => fileCount), [0]);

    index.setEnabled(workspace.id, true);
    assert.equal(index.search('innocuousnotesmarker').length, 0);
    for (const token of tokens) {
      assert.equal(index.search(token).length, 0, token);
    }
  } finally {
    index.close();
  }
});

test('workspace refresh skips files containing common credential formats', async () => {
  const directory = temporaryDirectory();
  const root = path.join(directory, 'project');
  fs.mkdirSync(root);
  const fakeValue = 'a'.repeat(32);
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature-value-123';
  write(root, 'README.md', 'safe public marker\n');
  write(root, 'config.yaml', `api_key: ${fakeValue}\n`);
  write(root, 'start.sh', `export API_KEY=${fakeValue}\n`);
  write(root, 'client.js', `const token = "${fakeValue}";\n`);
  write(root, 'jwt.txt', `Authorization: Bearer ${jwt}\n`);
  write(root, 'connection.txt', 'postgres://alice:supersecret@example.com/database\n');
  write(root, 'private.txt', '-----BEGIN ENCRYPTED PRIVATE KEY-----\n');
  write(root, 'pgp.txt', '-----BEGIN PGP PRIVATE KEY BLOCK-----\n');

  const index = createIndex(directory);
  try {
    const workspace = index.add(root);
    const result = await index.refresh(workspace.id);
    assert.equal(result.indexed, 1);
    assert.ok(result.skipped >= 7);
    assert.equal(result.workspace.indexComplete, true);
    index.setEnabled(workspace.id, true);
    assert.equal(index.search('public marker').length, 1);
    assert.equal(index.search(fakeValue).length, 0);
    assert.equal(index.search('supersecret').length, 0);
  } finally {
    index.close();
  }
});

test('workspace indexing refuses home/private roots and skips the app user-data subtree', async () => {
  const directory = temporaryDirectory();
  const index = createIndex(directory);
  try {
    assert.throws(() => index.add(os.homedir()), /home|broad|private/i);
    assert.throws(() => index.add(path.join(directory, 'user-data')), /private|Volyx Lens/i);
  } finally {
    index.close();
  }

  const root = temporaryDirectory();
  write(root, 'README.md', 'public project marker\n');
  write(root, 'user-data/settings.json', 'private settings marker\n');
  const scopedIndex = createIndex(root);
  try {
    const workspace = scopedIndex.add(root);
    const result = await scopedIndex.refresh(workspace.id);
    assert.equal(result.indexed, 1);
    scopedIndex.setEnabled(workspace.id, true);
    assert.equal(scopedIndex.search('public project marker').length, 1);
    assert.equal(scopedIndex.search('settings').length, 0);
  } finally {
    scopedIndex.close();
  }
});

test('workspace file reads request at most one byte beyond the configured limit', async () => {
  const requested = [];
  const handle = {
    async read(buffer, offset, length) {
      requested.push(length);
      const count = Math.min(length, 2);
      buffer.fill(1, offset, offset + count);
      return { bytesRead: count };
    },
  };
  const content = await readBoundedFile(handle, 5);
  assert.equal(content.length, 6);
  assert.ok(requested.every((length) => length <= 6));
});

test('workspace snippets center on a match deep inside a minified file', () => {
  const content = `${'x'.repeat(5000)} targetphrase ${'y'.repeat(5000)}`;
  const snippet = safeSnippet(content, ['targetphrase']);
  assert.match(snippet.snippet, /targetphrase/);
  assert.ok(snippet.snippet.length <= 1400);
  assert.equal(snippet.lineStart, 1);
});

test('workspace snippets retain diacritic matches found by FTS', () => {
  const content = `${'x'.repeat(5000)} café launch ${'y'.repeat(5000)}`;
  const snippet = safeSnippet(content, ['cafe']);
  assert.match(snippet.snippet, /café launch/);
});

test('workspace snippets ignore query substrings inside larger tokens', () => {
  const content = `concatenate ${'x'.repeat(5000)} standalone cat target`;
  const snippet = safeSnippet(content, ['cat']);
  assert.match(snippet.snippet, /standalone cat target/);
  assert.doesNotMatch(snippet.snippet, /concatenate/);
});

test('workspace snippets locate underscore-separated query phrases in tokenized content', () => {
  const content = `unrelated-marker ${'x'.repeat(6000)} foo bar target`;
  const snippet = safeSnippet(content, ['foo_bar']);
  assert.match(snippet.snippet, /foo bar target/);
  assert.doesNotMatch(snippet.snippet, /unrelated-marker/);
});

test('workspace schema upgrades invalidate indexes built under older exclusion policies', async () => {
  const directory = temporaryDirectory();
  const root = path.join(directory, 'project');
  fs.mkdirSync(root);
  write(root, 'README.md', 'workspace policy marker\n');
  const databasePath = path.join(directory, 'user-data', 'workspace-index.sqlite');
  const first = createWorkspaceIndex({ databasePath });
  const workspace = first.add(root);
  await first.refresh(workspace.id);
  first.setEnabled(workspace.id, true);
  first.close();

  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(databasePath);
  raw.exec('PRAGMA user_version = 0');
  raw.close();

  const upgraded = createWorkspaceIndex({ databasePath });
  try {
    const listed = upgraded.list()[0];
    assert.equal(listed.indexComplete, false);
    assert.equal(listed.fileCount, 0);
    assert.equal(upgraded.search('policy marker').length, 0);
    await upgraded.refresh(workspace.id);
    upgraded.setEnabled(workspace.id, true);
    assert.equal(upgraded.search('policy marker').length, 1);
  } finally {
    upgraded.close();
  }
});

test('workspace citations disambiguate folders with the same basename', async () => {
  const directory = temporaryDirectory();
  const firstRoot = path.join(directory, 'one', 'app');
  const secondRoot = path.join(directory, 'two', 'app');
  fs.mkdirSync(firstRoot, { recursive: true });
  fs.mkdirSync(secondRoot, { recursive: true });
  write(firstRoot, 'README.md', 'shared citation first\n');
  write(secondRoot, 'README.md', 'shared citation second\n');
  const index = createIndex(directory);
  try {
    const first = index.add(firstRoot);
    const second = index.add(secondRoot);
    assert.notEqual(index.list().find((item) => item.id === first.id).name, index.list().find((item) => item.id === second.id).name);
    await index.refresh(first.id);
    await index.refresh(second.id);
    index.setEnabled(first.id, true);
    index.setEnabled(second.id, true);
    const matches = index.search('shared citation');
    assert.equal(matches.length, 2);
    assert.equal(new Set(matches.map((match) => match.workspaceName)).size, 2);
  } finally {
    index.close();
  }
});

test('file rules include useful text formats and reject common secret paths', () => {
  assert.equal(isSupportedTextFile('service.ts'), true);
  assert.equal(isSupportedTextFile('config.yaml'), true);
  assert.equal(isSupportedTextFile('package.json'), true);
  assert.equal(isSupportedTextFile('Makefile'), true);
  assert.equal(isSupportedTextFile('go.mod'), true);
  assert.equal(isSupportedTextFile('.env.production'), false);
  assert.equal(isSupportedTextFile('credentials.json'), false);
  assert.equal(isSupportedTextFile('package-lock.json'), false);
  assert.equal(isSupportedTextFile('go.sum'), false);
  assert.equal(isExcludedName('node_modules'), true);
  assert.equal(isSupportedTextFile('image.png'), false);
  const fakeApiToken = ['sk', '-', 'a'.repeat(28)].join('');
  assert.equal(containsLikelySecret(`const API_KEY = "${fakeApiToken}";`), true);
  assert.equal(containsLikelySecret('const apiKey = process.env.API_KEY;'), false);
});

test('workspace indexing refuses folders nested under a private directory', () => {
  const directory = temporaryDirectory();
  const root = path.join(directory, '.config', 'containers');
  fs.mkdirSync(root, { recursive: true });
  const index = createIndex(directory);
  try {
    assert.throws(() => index.add(root), /private application or credential data/);
  } finally {
    index.close();
  }
});

test('refresh reclaims deleted rows before refusing a same-size replacement', async () => {
  const directory = temporaryDirectory();
  const root = path.join(directory, 'project');
  fs.mkdirSync(root, { recursive: true });
  const first = write(root, 'a.md', 'alphamarker content\n');
  const index = createIndex(directory, { maxTotalBytes: 24 });
  try {
    const workspace = index.add(root);
    await index.refresh(workspace.id);
    index.setEnabled(workspace.id, true);
    assert.equal(index.search('alphamarker').length, 1);

    fs.rmSync(first);
    write(root, 'b.md', 'betamarker content\n');
    const result = await index.refresh(workspace.id);
    assert.equal(result.incomplete, false);
    assert.equal(index.search('betamarker').length, 1);
    assert.equal(index.search('alphamarker').length, 0);
  } finally {
    index.close();
  }
});

test('retained rows cannot exceed the file limit after replacements', async () => {
  const directory = temporaryDirectory();
  const root = path.join(directory, 'project');
  fs.mkdirSync(root, { recursive: true });
  const first = write(root, 'a.md', 'firstmarker\n');
  const second = write(root, 'b.md', 'secondmarker\n');
  const index = createIndex(directory, { maxFiles: 2 });
  try {
    const workspace = index.add(root);
    await index.refresh(workspace.id);
    index.setEnabled(workspace.id, true);
    assert.equal(index.list()[0].fileCount, 2);

    fs.rmSync(first);
    fs.rmSync(second);
    write(root, 'c.md', 'thirdmarker\n');
    write(root, 'd.md', 'fourthmarker\n');
    await index.refresh(workspace.id);
    assert.equal(index.list()[0].fileCount, 2);
    assert.equal(index.search('thirdmarker').length, 1);
    assert.equal(index.search('fourthmarker').length, 1);
    assert.equal(index.search('firstmarker').length, 0);
  } finally {
    index.close();
  }
});

test('a generic folder named library is not a private ancestor', () => {
  const directory = temporaryDirectory();
  const root = path.join(directory, 'code', 'library', 'project');
  fs.mkdirSync(root, { recursive: true });
  write(root, 'README.md', 'librarymarker\n');
  const index = createIndex(directory);
  try {
    const workspace = index.add(root);
    assert.ok(workspace && workspace.id);
  } finally {
    index.close();
  }
});

test('refresh refuses a workspace root retargeted to a different folder', async () => {
  const directory = temporaryDirectory();
  const root = path.join(directory, 'project');
  const privateDirectory = path.join(directory, '.ssh');
  fs.mkdirSync(root);
  fs.mkdirSync(privateDirectory);
  write(root, 'README.md', 'publicmarker\n');
  write(privateDirectory, 'config', 'sshnotemarker\n');
  const index = createIndex(directory);
  try {
    const workspace = index.add(root);
    await index.refresh(workspace.id);

    fs.rmSync(root, { recursive: true, force: true });
    fs.symlinkSync(privateDirectory, root, 'dir');
    await assert.rejects(() => index.refresh(workspace.id), /no longer available/);
    assert.equal(index.search('sshnotemarker').length, 0);
  } finally {
    index.close();
  }
});

test('a project inside the system temp tree is not treated as app data', () => {
  const directory = temporaryDirectory();
  const root = path.join(directory, 'AppData', 'Local', 'Temp', 'project');
  fs.mkdirSync(root, { recursive: true });
  write(root, 'README.md', 'tempmarker\n');
  const index = createIndex(directory);
  try {
    const workspace = index.add(root);
    assert.ok(workspace && workspace.id);
  } finally {
    index.close();
  }
});

test('short password assignments are refused even below the generic length floor', () => {
  assert.equal(containsLikelySecret('password: "P@ssw0rd!"'), true);
  assert.equal(containsLikelySecret('db_password = hunter2'), true);
  assert.equal(containsLikelySecret('password: ${DB_PASSWORD}'), false, 'an env reference is not a value');
  assert.equal(containsLikelySecret('password: change_me'), false, 'a placeholder is not a secret');
});

test('removing one workspace frees the shared byte cap for another', async () => {
  const directory = temporaryDirectory();
  const firstRoot = path.join(directory, 'first');
  const secondRoot = path.join(directory, 'second');
  fs.mkdirSync(firstRoot);
  fs.mkdirSync(secondRoot);
  write(firstRoot, 'README.md', 'firstmarker-content\n');
  write(secondRoot, 'README.md', 'secondmarker-content\n');
  const index = createIndex(directory, { maxTotalBytes: 24 });
  try {
    const first = index.add(firstRoot);
    await index.refresh(first.id);
    index.setEnabled(first.id, true);

    const second = index.add(secondRoot);
    index.setEnabled(second.id, true);
    index.remove(first.id);

    const result = await index.refresh(second.id);
    assert.equal(result.incomplete, false, 'space freed by the removal is reusable');
    assert.equal(index.search('secondmarker').length, 1);
    assert.equal(index.search('firstmarker').length, 0);
  } finally {
    index.close();
  }
});
