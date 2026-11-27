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
  const immediateStart = stopBlock.indexOf('if (immediate) {');
  const immediateBlock = stopBlock.slice(immediateStart, stopBlock.indexOf('\n  if (manager) {', immediateStart));
  assert.match(immediateBlock, /if \(manager\) await Promise\.allSettled\(\[manager\.stop\(\)\]\)/);
  assert.match(immediateBlock, /await defaultSpeechWorker\.stop\(\)/);
  assert.match(immediateBlock, /if \(localManager\)[\s\S]*localManager\.stop\(\)/, 'local streams stop before the shared worker');
  assert.match(immediateBlock, /await Promise\.allSettled\(\[\.\.\.drainingRealtimeManagers\]/);
  assert.match(immediateBlock, /transcriptEpoch \+= 1/);
  assert.doesNotMatch(immediateBlock, /transcript\.length = 0/, 'immediate teardown invalidates work without clearing visible transcript');
  assert.match(immediateBlock, /retryQueues\.you = \[\]; retryQueues\.them = \[\]/);
  assert.match(immediateBlock, /flushPromises\.you = null; flushPromises\.them = null/);
  assert.match(immediateBlock, /state\.transcribing\.you = false;\s*state\.transcribing\.them = false/);

  const normalBlock = stopBlock.slice(stopBlock.indexOf('\n  if (manager) {', immediateStart));
  assert.match(normalBlock, /buffers\.you = \[\]; buffers\.them = \[\];\s*retryQueues\.you = \[\]; retryQueues\.them = \[\]/);

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

test('diarization recording is Them-only, opt-in, and bounded in memory', () => {
  assert.match(main, /if \(channel === 'them' && diarizationRecorder\)/);
  assert.match(main, /diarization\.enabled !== true \|\| transcription\.historyEnabled !== true \|\| audio\.systemEnabled === false/);
  assert.match(main, /createDiarizationRecorder\(\{[\s\S]*?recordingId: `diar-\$\{Date\.now\(\)\.toString\(36\)\}-\$\{\+\+diarizationSequence\}`[\s\S]*?sampleRate: AUDIO_SAMPLE_RATE[\s\S]*?maxMinutes:/);
  // The recorder never touches disk: audio only lives in the session buffer.
  assert.doesNotMatch(main, /writeFile[^\n]*diariz/i);
  assert.doesNotMatch(main, /appendFile[^\n]*diariz/i);
});

test('every session boundary cancels, clears, or restarts the diarization recorder', () => {
  // Normal stop: save the transcript first, then analyze. Immediate stop never
  // analyzes the audio it just dropped.
  assert.match(main, /const finalized = finalizeMeeting\([\s\S]*?if \(!immediate\) await speechOperationGate\.run\('diarization', \(\) => analyzeDiarization\(finalized\.id \|\| activeMeetingRecordId\)\)/);
  assert.match(main, /if \(immediate \|\| reason === 'suspend' \|\| reason === 'lock'\) clearDiarizationRecorder\(\)/);

  // Immediate quit invalidates the generation before zeroing the recording.
  const shutdownStart = main.indexOf('async function shutdownAll()');
  const shutdownBlock = main.slice(shutdownStart, main.indexOf('function stopAllAndQuit()', shutdownStart));
  assert.match(shutdownBlock, /diarizationAnalysisGeneration \+= 1;\s*clearDiarizationRecorder\(\)/);

  // New Session and Clear Transcript start a fresh recording when capture
  // continues; history-off cancels anything in flight.
  assert.match(main, /function startNewSession[\s\S]*?clearDiarizationRecorder\(\);[\s\S]*?restartDiarizationRecorderForContinuedCapture\(\)/);
  assert.match(main, /handleTrusted\('transcript:clear'[\s\S]*?clearDiarizationRecorder\(\);[\s\S]*?await startTranscriptionPipeline\(\)/);
  assert.match(main, /async function startTranscriptionPipeline\(\) \{[\s\S]*?if \(state\.capturing && !diarizationRecorder\) startDiarizationRecorder\(store\.getSettings\(\)\.audio \|\| \{\}\)/);
  assert.match(main, /function cancelDiarizationForHistoryChange\(\)[\s\S]*?diarizationAnalysisGeneration \+= 1;[\s\S]*?clearDiarizationRecorder\(\)/);
  assert.match(main, /if \(wasHistoryEnabled && !isHistoryEnabled\) \{[\s\S]*?cancelDiarizationForHistoryChange\(\)/);
});

test('diarization analysis zeroes audio on every exit and never persists a partial run', () => {
  assert.match(main, /if \(snapshot\.truncated\) \{[\s\S]*?duration_limit_exceeded/);
  assert.match(main, /snapshot\.durationMs < 1000[\s\S]*?insufficient_system_audio/);
  assert.match(main, /snapshot\.pcm\.fill\(0\)/);
  assert.match(main, /if \(wav\) wav\.fill\(0\)/);
  assert.match(main, /isCancelled: \(\) => analysisGeneration !== diarizationAnalysisGeneration[\s\S]*?historyEnabled !== true/);
  assert.match(main, /if \(analysisGeneration !== diarizationAnalysisGeneration \|\| !stillEnabled\) return null/);
});
