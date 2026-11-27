'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const responseContext = fs.readFileSync(path.join(root, 'src', 'response-context.js'), 'utf8');
const { MODES } = require('../src/prompts');

test('workspace index controls cross the trusted preload bridge', () => {
  for (const method of ['Get', 'Add', 'Refresh', 'Rebuild', 'SetEnabled', 'Remove']) {
    assert.match(preload, new RegExp(`workspaceIndex${method}:`));
  }
  for (const channel of ['get', 'add', 'refresh', 'rebuild', 'set-enabled', 'remove']) {
    assert.match(main, new RegExp(`handleTrusted\\('workspace-index:${channel}'`));
  }
  assert.match(main, /properties: \['openDirectory'\]/);
  assert.match(main, /getWorkspaceIndex\(\)\.rebuild\(String\(id \|\| ''\)\)/);
  assert.match(renderer, /workspaceIndexRebuild\(workspace\.id\)/);
  assert.match(renderer, /rebuild\.textContent = 'Rebuild'/);
});

test('shutdown waits for workspace index writes to finish', () => {
  assert.match(main, /await workspaceIndex\.close\(\);/);
});

test('workspace matches are opt-in, disclosed in the answer badge, and treated as untrusted', () => {
  assert.match(main, /readOptionalContext\('workspace', \(\) => getWorkspaceIndex\(\)\.search\(relevanceQuery\)/);
  assert.match(main, /new Map\(workspaceMatches\.map\(\(match\) => \[match\.workspaceId, match\.workspaceName\]\)\)\.values\(\)/);
  assert.match(renderer, /Workspace files:/);
  assert.match(responseContext, /indexed workspace files.*untrusted reference data/);
});

test('workspace context is limited to modes that explicitly permit it', () => {
  assert.equal(MODES.assist.usesWorkspaceContext, true);
  assert.equal(MODES.ask.usesWorkspaceContext, true);
  for (const mode of ['assist-screen', 'assist-conversation', 'say', 'auto-assist', 'followup', 'recap', 'slide-review', 'leetcode']) {
    assert.notEqual(MODES[mode].usesWorkspaceContext, true, mode);
  }
  assert.match(main, /def\.usesWorkspaceContext === true/);
});

test('workspace settings disclose local plaintext storage and use safe DOM text assignment', () => {
  assert.match(html, /The local index is not encrypted by Volyx Lens/);
  assert.match(html, /workspace-index-list/);
  assert.match(renderer, /meta\.textContent = `\$\{workspace\.rootPath\}/);
  assert.match(renderer, /title\.textContent = workspace\.name/);
  assert.doesNotMatch(renderer, /enabled\.disabled = !workspace\.indexComplete/);
});

test('workspace snippets are re-read after capture, like meeting memory', () => {
  const workspaceRead = main.indexOf("readOptionalContext('workspace'");
  const captureDone = main.indexOf('currentScreen = await captureScreenshot');
  assert.ok(workspaceRead > 0 && captureDone > 0);
  assert.ok(workspaceRead > captureDone, 'a folder disabled during capture must not be uploaded');
});
