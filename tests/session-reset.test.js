const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');

test('new session is available as an explicit control and /new command', () => {
  assert.match(html, /id="new-session-btn"[^>]*data-icon-only="true"/);
  assert.match(html, /id="new-session-btn"[^>]*title="Start a fresh conversation"[^>]*aria-label="New Session"/);
  assert.doesNotMatch(html, /<span>New Session<\/span>/);
  assert.match(preload, /newSession:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('session:new'\)/);
  assert.match(renderer, /text === '\/new'/);
  assert.match(renderer, /volyxLens\.newSession\(\)/);
});

test('main-process reset invalidates old async work and clears all conversation context', () => {
  assert.match(main, /let sessionGeneration = 0/);
  assert.match(main, /function startNewSession/);
  assert.match(main, /sessionGeneration \+= 1/);
  assert.match(main, /transcript\.length = 0/);
  assert.match(main, /buffers\.you = \[\]; buffers\.them = \[\]/);
  assert.match(main, /handleTrusted\('session:new'/);
  assert.match(main, /generation !== sessionGeneration/);
});

test('hard session boundaries await speech teardown and clear retry audio before restart', () => {
  const stopStart = main.indexOf('async function stopTranscriptionPipeline(');
  const stopBlock = main.slice(stopStart, main.indexOf('function routePcm', stopStart));
  assert.match(stopBlock, /if \(manager\) await Promise\.allSettled\(\[manager\.stop\(\)\]\);/);
  assert.match(stopBlock, /await Promise\.allSettled\(\[\.\.\.drainingRealtimeManagers\]/);
  assert.match(stopBlock, /retryQueues\.you = \[\]; retryQueues\.them = \[\]/);
  assert.match(stopBlock, /flushPromises\.you = null; flushPromises\.them = null;/);

  const resetStart = main.indexOf('function startNewSession()');
  const resetBlock = main.slice(resetStart, main.indexOf('async function importPersonalContextDocument', resetStart));
  assert.match(resetBlock, /await stopTranscriptionPipeline\(\{ immediate: true \}\)/);
  assert.match(resetBlock, /await startTranscriptionPipeline\(\)/);
  assert.match(resetBlock, /retryQueues\.you = \[\]; retryQueues\.them = \[\]/);
});

test('startup begins with an empty conversation instead of canned demo content', () => {
  assert.doesNotMatch(renderer, /discounted cash flow|showExample/);
  assert.match(renderer, /async function boot\(\)[\s\S]*clearMessages\(\)[\s\S]*syncPlaceholder\(\)/);
});

test('renderer clears old transcript and generated answers after reset', () => {
  assert.match(preload, /'session:cleared'/);
  assert.match(renderer, /volyxLens\.on\('session:cleared'/);
  assert.match(renderer, /clearMessages\(\)/);
  assert.match(renderer, /clearTranscriptWorkspace\(\)/);
});
