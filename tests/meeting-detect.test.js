'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createMeetingDetector, DEFAULT_WINDOW_MS } = require('../src/meeting-detect');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const providerConfig = fs.readFileSync(path.join(root, 'src', 'provider-config.js'), 'utf8');
const store = fs.readFileSync(path.join(root, 'src', 'store.js'), 'utf8');
const meetingStore = fs.readFileSync(path.join(root, 'src', 'meeting-store.js'), 'utf8');

const now = 1_700_000_000_000;
const min = 60 * 1000;

test('detector stays idle on one-sided or sparse speech', () => {
  const detector = createMeetingDetector({ now: () => now });
  const t0 = now;
  const them = [t0, t0 + 1 * min, t0 + 2 * min].map((ts, i) => ({ channel: 'them', text: `Statement ${i + 1}`, ts }));
  for (const turn of them) detector.add(turn);
  assert.equal(detector.snapshot().meeting, false);
});

test('detector ignores empty turns and non-object input', () => {
  const detector = createMeetingDetector({ now: () => now });
  const t0 = now;
  const turns = [
    { channel: 'them', text: '  ', ts: t0 },
    null,
    { channel: 'you', text: 'Reply one', ts: t0 + 1 * min },
    { channel: 'them', text: '', ts: t0 + 2 * min },
    { channel: 'them', text: 'Follow up', ts: t0 + 3 * min },
  ];
  for (const turn of turns) detector.add(turn);
  assert.equal(detector.snapshot().meeting, false);
});

test('detector flags a sustained two-sided, alternating conversation', () => {
  const detector = createMeetingDetector({ now: () => now });
  const t0 = now;
  const turns = [
    { channel: 'them', text: 'Welcome to the review.', ts: t0 },
    { channel: 'you', text: 'Thanks for having me.', ts: t0 + 1 * min },
    { channel: 'them', text: 'Let us walk through the roadmap.', ts: t0 + 2 * min },
    { channel: 'you', text: 'The roadmap looks strong.', ts: t0 + 3 * min },
    { channel: 'them', text: 'We should ship it next week.', ts: t0 + 4 * min },
    { channel: 'you', text: 'Agreed, shipping next week.', ts: t0 + 5 * min },
  ];
  for (const turn of turns) detector.add(turn);
  const state = detector.snapshot();
  assert.equal(state.meeting, true);
  assert.equal(state.youTurns, 3);
  assert.equal(state.themTurns, 3);
  assert.ok(state.flips >= 2);
  assert.equal(state.detectedSince, t0 + 5 * min);
});

test('detector requires enough turns per side even with alternation', () => {
  const detector = createMeetingDetector({ now: () => now });
  const t0 = now;
  const turns = [
    { channel: 'them', text: 'First.', ts: t0 },
    { channel: 'you', text: 'Reply.', ts: t0 + 1 * min },
    { channel: 'them', text: 'Second.', ts: t0 + 2 * min },
    { channel: 'you', text: 'Reply again.', ts: t0 + 3 * min },
  ];
  for (const turn of turns) detector.add(turn);
  assert.equal(detector.snapshot().meeting, false);
});

test('detector expires old turns out of the rolling window', () => {
  const detector = createMeetingDetector({ now: () => now });
  const t0 = now;
  const turns = [
    { channel: 'them', text: 'One.', ts: t0 },
    { channel: 'you', text: 'Reply.', ts: t0 + 1 * min },
    { channel: 'them', text: 'Two.', ts: t0 + 2 * min },
    { channel: 'you', text: 'Reply.', ts: t0 + 3 * min },
    { channel: 'them', text: 'Three.', ts: t0 + 4 * min },
  ];
  for (const turn of turns) detector.add(turn);
  assert.equal(detector.snapshot().meeting, false);
  // A burst well inside the window triggers detection.
  detector.reset();
  const recent = [
    { channel: 'them', text: 'A.', ts: t0 + 10 * min },
    { channel: 'you', text: 'B.', ts: t0 + 11 * min },
    { channel: 'them', text: 'C.', ts: t0 + 12 * min },
    { channel: 'you', text: 'D.', ts: t0 + 13 * min },
    { channel: 'them', text: 'E.', ts: t0 + 14 * min },
    { channel: 'you', text: 'F.', ts: t0 + 15 * min },
  ];
  for (const turn of recent) detector.add(turn);
  assert.equal(detector.snapshot().meeting, true);
  assert.equal(DEFAULT_WINDOW_MS, 5 * 60 * 1000);
});

test('reset clears detection state', () => {
  const detector = createMeetingDetector({ now: () => now });
  const t0 = now;
  const turns = [
    { channel: 'them', text: 'A.', ts: t0 },
    { channel: 'you', text: 'B.', ts: t0 + 1 * min },
    { channel: 'them', text: 'C.', ts: t0 + 2 * min },
    { channel: 'you', text: 'D.', ts: t0 + 3 * min },
    { channel: 'them', text: 'E.', ts: t0 + 4 * min },
    { channel: 'you', text: 'F.', ts: t0 + 5 * min },
  ];
  for (const turn of turns) detector.add(turn);
  assert.equal(detector.snapshot().meeting, true);
  detector.reset();
  const state = detector.snapshot();
  assert.equal(state.meeting, false);
  assert.equal(state.detectedSince, null);
  assert.equal(state.windowTurns, 0);
});

test('remove retracts a leaked contribution and can withdraw a false meeting', () => {
  const detector = createMeetingDetector({ now: () => now });
  const t0 = now;
  const turns = [
    { id: 1, channel: 'them', text: 'One.', ts: t0 },
    { id: 2, channel: 'you', text: 'Reply.', ts: t0 + 1 * min },
    { id: 3, channel: 'them', text: 'Two.', ts: t0 + 2 * min },
    { id: 4, channel: 'you', text: 'Reply again.', ts: t0 + 3 * min },
    { id: 5, channel: 'them', text: 'Three.', ts: t0 + 4 * min },
    { id: 6, channel: 'you', text: 'Leaked mic echo that is later suppressed.', ts: t0 + 5 * min },
  ];
  for (const turn of turns) detector.add(turn);
  assert.equal(detector.snapshot().meeting, true);
  // The leaked mic segment is removed as cross-talk; without it the two-sided
  // threshold no longer holds, so detection is withdrawn rather than latched.
  detector.remove(6);
  const state = detector.snapshot();
  assert.equal(state.meeting, false);
  assert.equal(state.detectedSince, null);
  assert.equal(state.youTurns, 2);
  assert.equal(state.themTurns, 3);
});

test('remove of an unknown or untyped id is a no-op', () => {
  const detector = createMeetingDetector({ now: () => now });
  detector.add({ id: 1, channel: 'you', text: 'Hi', ts: now });
  const before = detector.snapshot().windowTurns;
  assert.equal(detector.remove(999).windowTurns, before);
  assert.equal(detector.remove(null).windowTurns, before);
  assert.equal(detector.remove(undefined).windowTurns, before);
  assert.equal(detector.remove('1').windowTurns, before);
});

test('detector entries are keyed by segment id so removed turns do not linger', () => {
  const detector = createMeetingDetector({ now: () => now });
  const t0 = now;
  const turns = [
    { id: 1, channel: 'them', text: 'A.', ts: t0 },
    { id: 2, channel: 'you', text: 'B.', ts: t0 + 1 * min },
    { id: 3, channel: 'them', text: 'C.', ts: t0 + 2 * min },
    { id: 4, channel: 'you', text: 'D.', ts: t0 + 3 * min },
    { id: 5, channel: 'them', text: 'E.', ts: t0 + 4 * min },
    { id: 6, channel: 'you', text: 'F.', ts: t0 + 5 * min },
  ];
  for (const turn of turns) detector.add(turn);
  detector.remove(2);
  const state = detector.snapshot();
  assert.equal(state.meeting, false);
  assert.equal(state.youTurns, 2);
  assert.equal(state.windowTurns, 5);
});

test('meeting detection is opt-in, runs only in-session on finalized turns, and never calls a model', () => {
  assert.equal(providerConfig.includes('meetingDetection: false,'), true);
  assert.match(store, /meetingDetection'\) && typeof value\.meetingDetection === 'boolean'/);
  assert.match(main, /meetingDetection === true/);
  assert.match(main, /meetingDetector\.add\(\{ id: turn\.id, channel: normalizedChannel, text: turn\.text, ts: timestamp \}\)/);
  assert.match(main, /meetingDetection === true && !updated/);
  assert.match(main, /meetingDetector\.reset\(\)/);
  assert.match(main, /meeting:detected/);
  assert.doesNotMatch(main, /meetingDetector[\s\S]{0,200}(runFeature|\.stream\()/);
});

test('grouped-turn segment updates do not inflate the detector turn count', () => {
  assert.match(main, /meetingDetector\.add\(\{ id: turn\.id, channel: normalizedChannel, text: turn\.text, ts: timestamp \}\)/);
  const addBlock = main.match(/meetingDetection === true && !updated[\s\S]{0,120}/);
  assert.ok(addBlock, 'detector add is gated on a newly created turn');
  assert.match(addBlock[0], /meetingDetector\.add/);
});

test('suppressed cross-talk retracts a fully removed leaked turn and clears the indicator', () => {
  assert.match(main, /const turnRemoved = removeTranscriptSegment\(leakedSegment\)/);
  assert.match(main, /meetingDetection === true && turnRemoved/);
  assert.match(main, /meetingDetector\.remove\(leakedSegment\.turnId\)/);
  assert.match(main, /if \(!state\.meeting && meetingDetectedNotified\)/);
  assert.match(main, /meetingDetectedNotified = false;/);
  assert.match(main, /send\('meeting:cleared', \{\}\)/);
  assert.match(preload, /'meeting:cleared'/);
  assert.match(renderer, /volyxLens\.on\('meeting:cleared'/);
  assert.match(renderer, /meeting-indicator'\)\.classList\.add\('hidden'\)/);
});

test('cross-talk that only trims one segment of a surviving turn keeps its detector entry', () => {
  const retractBlock = main.match(/meetingDetection === true && turnRemoved[\s\S]{0,160}/);
  assert.ok(retractBlock, 'retraction is gated on the turn being fully removed');
  assert.match(retractBlock[0], /meetingDetector\.remove\(leakedSegment\.turnId\)/);
  assert.match(main, /return true;\n\s*\}/);
  assert.match(main, /return false;\n\s*\}/);
});

test('capture stop resets the detector so each listening period is classified independently', () => {
  const stopBlock = main.match(/reason !== 'suspend' && reason !== 'lock'[\s\S]{0,220}/);
  assert.ok(stopBlock, 'capture-stop finalize block exists');
  assert.match(stopBlock[0], /finalizeMeeting\(reason \|\| 'capture-stop'/);
  assert.match(stopBlock[0], /meetingDetector\.reset\(\)/);
  assert.match(stopBlock[0], /meetingDetectedNotified = false;/);
});

test('main tags finalized history records with the meeting flag', () => {
  assert.match(main, /meeting: meetingDetector\.snapshot\(\)\.meeting/);
  assert.match(meetingStore, /meeting = false/);
  assert.match(meetingStore, /meeting: meeting === true,/);
  assert.match(meetingStore, /meeting: record\.meeting === true,/);
  assert.match(preload, /'meeting:detected'/);
});

test('record saved and meeting flag round-trip through the store', () => {
  const os = require('node:os');
  const { createMeetingStore } = require('../src/meeting-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-detect-'));
  const store = createMeetingStore({ dir });
  const turns = [
    { channel: 'them', text: 'A', ts: 1 },
    { channel: 'you', text: 'B', ts: 2 },
  ];
  const saved = store.finalize({ turns, enabled: true, meeting: true });
  assert.equal(saved.saved, true);
  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].meeting, true);
  const record = store.get(list[0].id);
  assert.equal(record.meeting, true);
});

const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');

test('renderer surfaces the meeting indicator and a discrete status when detected', () => {
  assert.match(renderer, /volyxLens\.on\('meeting:detected'/);
  assert.match(renderer, /meeting-indicator'\)\.classList\.remove\('hidden'\)/);
  assert.match(renderer, /Meeting in progress detected in this session\./);
  assert.match(renderer, /meetingDetectedSince = null;/);
  assert.match(html, /id="meeting-indicator" class="hidden"/);
  assert.match(html, /id="stt-meeting-detection" type="checkbox"/);
  assert.match(html, /Detect meetings/);
  assert.match(html, /no background audio watcher, no disk writes, and no AI requests/);
  assert.match(css, /#meeting-indicator \{/);
  assert.match(renderer, /meetingDetection: \$\('#stt-meeting-detection'\)\.checked/);
  assert.match(renderer, /stt-meeting-detection'\)\.checked = transcription\.meetingDetection === true/);
});

test('Phase 4b: history entries and detail show the meeting badge', () => {
  assert.match(renderer, /history-meeting-badge/);
  assert.match(renderer, /record\.meeting/);
  assert.match(renderer, /Meeting detected/);
  assert.match(css, /\.history-meeting-badge \{/);
});

test('Phase 4b: exports and recap headers reflect the meeting flag', () => {
  const notes = fs.readFileSync(path.join(root, 'src', 'meeting-notes.js'), 'utf8');
  assert.match(notes, /record\.meeting === true \? 'meeting' : 'session'/);
  assert.match(notes, /Meeting: detected as a two-sided conversation/);
  assert.match(notes, /meeting: record\.meeting === true,/);
});