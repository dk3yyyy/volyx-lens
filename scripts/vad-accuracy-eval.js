#!/usr/bin/env node
'use strict';

// Repeatable VAD accuracy evaluation (Milestone 2).
//
// Generates a deterministic speech test set — accents via macOS `say`,
// synthetic noise, cross-talk overlays, technical terms, numbers, long
// pauses, and empty turns — then runs Volyx Lens's VoiceActivityDetector
// over every fixture and reports:
//   - empty-turn rate   (VAD fires on silence / sub-threshold noise)
//   - false-negative    (VAD misses real speech)
//   - boundary error    (start/end offset vs the known speech region)
//   - truncation        (speech cut short by the utterance cap or a false gap)
//   - WER               (word error rate, only when a whisper adapter is
//                        configured via VOLYX_LENS_WHISPER_CLI / _MODEL)
//
// Usage:
//   npm run eval:vad                 generate fixtures if needed, then evaluate
//   npm run eval:vad -- --regenerate rebuild the cached audio fixtures
//   npm run eval:vad -- --report     only re-evaluate the existing fixtures
//
// The generated WAVs live in node_modules/.cache/vad-eval (gitignored), so the
// evaluation set definition here is the repeatable artifact, not binary audio.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { VoiceActivityDetector } = require('../src/voice-activity');
const { AUDIO_SAMPLE_RATE } = require('../src/audio-config');
const { rms16, pcmToWav } = require('../src/wav');
const { validateOfflineConfig, transcribeOffline } = require('../src/offline-stt');

const CACHE_DIR = path.join(__dirname, '..', 'node_modules', '.cache', 'vad-eval');
const CHUNK_MS = 50;
const LEAD_MS = 500;
const DEFAULT_RATE = 150;
const START_TOLERANCE_MS = 400;
const END_TOLERANCE_MS = 900;
const TRUNCATION_TOLERANCE_MS = 1500;
const VAD_OPTIONS = { threshold: 160, silenceMs: 700, maxUtteranceMs: 20000 };

// -------- deterministic PRNG (mulberry32) --------
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// -------- WAV helpers --------
function decodeWav(buffer) {
  if (!buffer || buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file.');
  }
  // Walk RIFF chunks: `say` can emit JUNK/FLLR chunks before fmt and data.
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataOffset = -1;
  let dataSize = 0;
  let cursor = 12;
  while (cursor + 8 <= buffer.length) {
    const id = buffer.toString('ascii', cursor, cursor + 4);
    const size = buffer.readUInt32LE(cursor + 4);
    if (id === 'fmt ') {
      channels = buffer.readUInt16LE(cursor + 10);
      sampleRate = buffer.readUInt32LE(cursor + 12);
      bits = buffer.readUInt16LE(cursor + 22);
    } else if (id === 'data') {
      dataOffset = cursor + 8;
      dataSize = size;
      break;
    }
    cursor += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (channels !== 1 || bits !== 16) {
    throw new Error(`Expected mono 16-bit PCM, got ${channels}ch/${bits}bit.`);
  }
  return { pcm: Buffer.from(buffer.subarray(dataOffset, dataOffset + dataSize)), sampleRate };
}

function silencePcm(seconds, sampleRate = AUDIO_SAMPLE_RATE) {
  return Buffer.alloc(Math.max(0, Math.round(seconds * sampleRate)) * 2);
}

// -------- synthetic audio --------
function noisePcm(seconds, sampleRate, kind, seed, gain = 1) {
  const sampleCount = Math.max(0, Math.round(seconds * sampleRate));
  const random = mulberry32(seed);
  const pcm = Buffer.alloc(sampleCount * 2);
  let previous = 0;
  const b0 = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < sampleCount; i += 1) {
    let sample;
    if (kind === 'pink') {
      const white = random() * 2 - 1;
      b0[0] = 0.99886 * b0[0] + white * 0.0555179;
      b0[1] = 0.99332 * b0[1] + white * 0.0750759;
      b0[2] = 0.96900 * b0[2] + white * 0.1538520;
      b0[3] = 0.86650 * b0[3] + white * 0.3104856;
      b0[4] = 0.55000 * b0[4] + white * 0.5329522;
      b0[5] = -0.7616 * b0[5] - white * 0.0168980;
      sample = (b0[0] + b0[1] + b0[2] + b0[3] + b0[4] + b0[5] + b0[6] + white * 0.5362) * 0.11;
      b0[6] = white * 0.115926;
    } else {
      sample = random() * 2 - 1;
    }
    sample = previous * 0.2 + sample * 0.8;
    previous = sample;
    const clamped = Math.max(-1, Math.min(1, sample * gain));
    pcm.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  return pcm;
}

function scaleToRms(pcm, target) {
  const current = rms16(pcm);
  if (!current) return Buffer.from(pcm);
  const gain = target / current;
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i) * gain;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), i);
  }
  return out;
}

function mixPcm(primary, overlay, overlayStartMs, sampleRate = AUDIO_SAMPLE_RATE) {
  const startSample = Math.max(0, Math.round((overlayStartMs / 1000) * sampleRate));
  const out = Buffer.from(primary);
  for (let i = 0; i < overlay.length; i += 2) {
    const outIndex = startSample * 2 + i;
    if (outIndex + 2 > out.length) break;
    const sum = out.readInt16LE(outIndex) + overlay.readInt16LE(i);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sum)), outIndex);
  }
  return out;
}

function insertSilenceGap(pcm, gapMs, sampleRate = AUDIO_SAMPLE_RATE) {
  const gapSamples = Math.round((gapMs / 1000) * sampleRate);
  const gap = Buffer.alloc(gapSamples * 2);
  const midpoint = Math.floor(pcm.length / 4) * 2; // quarter point keeps a speech tail
  const head = pcm.subarray(0, midpoint);
  const tail = pcm.subarray(midpoint);
  return Buffer.concat([head, gap, tail]);
}

// -------- fixture manifest (the repeatable evaluation set) --------
function buildFixtures() {
  const speech = (id, category, text, extra = {}) => ({ id, category, kind: 'speech', text, ...extra });
  return [
    // Accents — one short question per voice, where available.
    speech('accent-us', 'accents', 'What was the hardest reliability issue you solved?', { voice: 'Samantha' }),
    speech('accent-uk', 'accents', 'Could you walk me through the billing details one more time?', { voice: 'Daniel' }),
    speech('accent-au', 'accents', 'How does the deployment pipeline handle a failed build?', { voice: 'Karen' }),
    speech('accent-za', 'accents', 'Can you share the latest numbers from the meeting?', { voice: 'Tessa' }),
    speech('accent-ie', 'accents', 'Why did the test suite stop running overnight?', { voice: 'Moira' }),
    speech('accent-in', 'accents', 'Which document describes the new rate limiting rules?', { voice: 'Aman' }),
    // Technical terms — model names, endpoints, deployment identifiers.
    speech('tech-realtime', 'technical', 'The gpt realtime whisper endpoint uses a twenty four kilohertz stream.'),
    speech('tech-nova', 'technical', 'The nova three model streams interim results with endpointing.'),
    speech('tech-azure', 'technical', 'Set the azure deployment name to gpt dash realtime dash whisper.'),
    speech('tech-fallback', 'technical', 'The fallback model is gpt four o mini transcribe.'),
    // Numbers — budget figures, times, versions, percentages.
    speech('num-budget', 'numbers', 'The budget is forty two thousand three hundred and ten dollars.'),
    speech('num-time', 'numbers', 'Call me back at five fifteen PM.'),
    speech('num-version', 'numbers', 'Version two point one point seven fixed the issue.'),
    speech('num-uptime', 'numbers', 'We need ninety percent uptime this quarter.'),
    // Long pauses — silence gaps longer than the VAD hangover (700 ms).
    speech('pause-4s', 'long-pauses', 'Let me think about that for a moment. Okay, I think we should move forward.', { pauseMs: 4000 }),
    speech('pause-8s', 'long-pauses', 'Let me think about that for a moment. Okay, I think we should move forward.', { pauseMs: 8000 }),
    // Cross-talk — two speakers overlaid mid-utterance.
    speech('crosstalk', 'cross-talk', 'What is the plan for tomorrow?', {
      voice: 'Samantha',
      overlay: { text: 'I think we should review the numbers first.', voice: 'Daniel', overlapMs: 2200 },
    }),
    // Noise — speech with synthetic noise overlaid at a fixed SNR.
    speech('noise-white-6', 'noise', 'How does the acoustic echo filter behave with loud system audio?', { noise: 'white', snrDb: 6 }),
    speech('noise-pink-0', 'noise', 'Can you reduce the background noise in the capture?', { noise: 'pink', snrDb: 0 }),
    // Long utterance — exercises the maxUtteranceMs cap.
    speech('long-utterance', 'long-pauses', 'The quarterly review covers the reliability work, the realtime transcription pipeline, the new providers, and the remaining accuracy evaluation that still needs a repeatable test set with accents, noise, cross-talk, technical terms, numbers, and long pauses.', { rate: 90 }),
    // Empty turns — no speech at all; VAD must stay quiet.
    { id: 'empty-silence', category: 'empty', kind: 'empty', empty: 'silence' },
    { id: 'empty-quiet-noise', category: 'empty', kind: 'empty', empty: 'quiet-noise' },
    { id: 'empty-near-threshold', category: 'empty', kind: 'empty', empty: 'near-threshold' },
  ];
}

// -------- TTS generation --------
function sayToWav(text, voice, outFile, rate = DEFAULT_RATE) {
  const direct = spawnSync('say', ['-v', voice, '-o', outFile, '--data-format=LEI16@24000', '-r', String(rate), text], { timeout: 60000 });
  if (direct.status === 0 && fs.existsSync(outFile) && fs.readFileSync(outFile).toString('ascii', 0, 4) === 'RIFF') return;
  const aiff = `${outFile}.aiff`;
  const spoken = spawnSync('say', ['-v', voice, '-o', aiff, '-r', String(rate), text], { timeout: 60000 });
  const converted = spawnSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@24000', aiff, outFile], { timeout: 60000 });
  if (aiff && fs.existsSync(aiff)) fs.unlinkSync(aiff);
  if (spoken.status !== 0 || converted.status !== 0 || !fs.existsSync(outFile)) {
    throw new Error(`say/afconvert failed for voice "${voice}" (${direct.status}/${spoken.status}/${converted.status}).`);
  }
}

function buildEmptyPcm(kind) {
  if (kind === 'silence') return silencePcm(1.0);
  if (kind === 'quiet-noise') return noisePcm(1.5, AUDIO_SAMPLE_RATE, 'white', 101, 0.001);
  return noisePcm(1.5, AUDIO_SAMPLE_RATE, 'white', 202, 0.004); // near threshold (rms ~160-ish scaled)
}

function generateFixture(fixture) {
  if (fixture.kind === 'empty') return buildEmptyPcm(fixture.empty);
  const voice = fixture.voice || 'Samantha';
  const outFile = path.join(CACHE_DIR, `_tmp-${fixture.id}.wav`);
  const overlayFile = path.join(CACHE_DIR, `_tmp-${fixture.id}-overlay.wav`);
  try {
    sayToWav(fixture.text, voice, outFile, fixture.rate || DEFAULT_RATE);
    const { pcm } = decodeWav(fs.readFileSync(outFile));
    let speech = pcm;
    if (fixture.overlay) {
      sayToWav(fixture.overlay.text, fixture.overlay.voice || 'Daniel', overlayFile, DEFAULT_RATE);
      const { pcm: overlayPcm } = decodeWav(fs.readFileSync(overlayFile));
      speech = mixPcm(speech, scaleToRms(overlayPcm, rms16(speech) * 0.9), fixture.overlay.overlapMs || 0);
    }
    return buildFixtureAudio(speech, fixture);
  } finally {
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    if (fs.existsSync(overlayFile)) fs.unlinkSync(overlayFile);
  }
}

function buildFixtureAudio(speech, fixture) {
  const lead = silencePcm(LEAD_MS / 1000);
  const trail = silencePcm(LEAD_MS / 1000);
  let pcmOut = Buffer.concat([lead, speech, trail]);
  if (fixture.pauseMs) pcmOut = insertSilenceGap(pcmOut, fixture.pauseMs);
  if (fixture.noise) {
    const speechRms = rms16(speech) || 1;
    const targetNoiseRms = speechRms / Math.pow(10, (fixture.snrDb || 0) / 20);
    const noise = noisePcm(pcmOut.length / 2 / AUDIO_SAMPLE_RATE, AUDIO_SAMPLE_RATE, fixture.noise, 303, 1);
    pcmOut = mixPcm(pcmOut, scaleToRms(noise, targetNoiseRms), 0);
  }
  return pcmOut;
}

// -------- VAD evaluation --------
function evaluatePcm(pcm, { sampleRate = AUDIO_SAMPLE_RATE, vadOptions = {}, fixture = null } = {}) {
  const vad = new VoiceActivityDetector({ sampleRate, ...VAD_OPTIONS, ...vadOptions });
  const chunkBytes = Math.round((CHUNK_MS / 1000) * sampleRate) * 2;
  const events = [];
  let ms = 0;
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    const chunk = pcm.subarray(offset, offset + chunkBytes);
    const result = vad.push(chunk);
    if (result.speechStarted) events.push({ type: 'start', ms });
    if (result.speechStopped) events.push({ type: result.forced ? 'forced' : 'stop', ms: ms + CHUNK_MS });
    ms += CHUNK_MS;
  }
  const starts = events.filter((e) => e.type === 'start').map((e) => e.ms);
  const stops = events.filter((e) => e.type === 'stop' || e.type === 'forced');
  const utterances = [];
  let openStart = null;
  for (const event of events) {
    if (event.type === 'start') openStart = event.ms;
    else if (openStart !== null) { utterances.push({ startMs: openStart, endMs: event.ms, forced: event.type === 'forced' }); openStart = null; }
  }
  if (openStart !== null) utterances.push({ startMs: openStart, endMs: ms, forced: false }); // speech still active at stream end
  return { events, starts, stops, utterances, durationMs: Math.round((pcm.length / 2 / sampleRate) * 1000) };
}

function fixtureRegion(fixture) {
  // Expected speech region for boundary checks (cross-talk has two speakers and
  // is only checked for detection, not precise boundaries).
  if (fixture.kind !== 'speech' || fixture.overlay) return null;
  return { startMs: LEAD_MS, endMs: null }; // end computed after generation
}

// -------- WER --------
function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(text) { return normalizeText(text) ? normalizeText(text).split(' ') : []; }

function wer(reference, hypothesis) {
  const ref = words(reference);
  const hyp = words(hypothesis);
  if (!ref.length) return hyp.length ? 1 : 0;
  const rows = ref.length + 1;
  const cols = hyp.length + 1;
  const d = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) d[i][0] = i;
  for (let j = 0; j < cols; j += 1) d[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[ref.length][hyp.length] / ref.length;
}

// -------- orchestration --------
function availableVoices() {
  const result = spawnSync('say', ['-v', '?'], { encoding: 'utf8' });
  if (result.status !== 0) return new Set();
  return new Set(String(result.stdout).split('\n').map((line) => line.split(/\s+/)[0]).filter(Boolean));
}

async function generateAll(force) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const manifestPath = path.join(CACHE_DIR, 'manifest.json');
  const fixtures = buildFixtures();
  const voices = availableVoices();
  const usable = fixtures.filter((fixture) => fixture.kind !== 'speech' || voices.has(fixture.voice || 'Samantha'));
  const cached = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')).map((id) => id)
    : [];
  let generated = 0;
  for (const fixture of usable) {
    const outFile = path.join(CACHE_DIR, `${fixture.id}.wav`);
    if (!force && fs.existsSync(outFile) && cached.includes(fixture.id)) continue;
    const pcm = generateFixture(fixture);
    fs.writeFileSync(outFile, pcmToWav(pcm, AUDIO_SAMPLE_RATE));
    generated += 1;
  }
  fs.writeFileSync(manifestPath, JSON.stringify(usable.map((f) => f.id)));
  return { fixtures: usable, generated, skippedVoices: fixtures.length - usable.length };
}

async function runEvaluation(fixtures) {
  const whisper = validateOfflineConfig(process.env);
  const rows = [];
  for (const fixture of fixtures) {
    const wav = fs.readFileSync(path.join(CACHE_DIR, `${fixture.id}.wav`));
    const { pcm, sampleRate } = decodeWav(wav);
    const result = evaluatePcm(pcm, { sampleRate, fixture });
    const region = fixtureRegion(fixture);
    const expectedEndMs = region ? result.durationMs - LEAD_MS : null;
    const firstStart = result.starts[0];
    const lastStop = result.stops.length ? result.stops[result.stops.length - 1] : null;
    const row = {
      id: fixture.id,
      category: fixture.category,
      kind: fixture.kind,
      durationMs: result.durationMs,
      utterances: result.utterances.length,
      splits: Math.max(0, result.utterances.length - (fixture.kind === 'speech' ? 1 : 0)),
      forced: result.utterances.some((u) => u.forced),
      startErrMs: region && firstStart !== undefined ? firstStart - region.startMs : null,
      endErrMs: region && lastStop !== null ? expectedEndMs - lastStop : null,
      detected: result.starts.length > 0,
    };
    if (whisper.ready && fixture.kind === 'speech' && !fixture.overlay) {
      try {
        const transcript = await transcribeOffline(pcmToWav(pcm, sampleRate), { env: process.env });
        row.wer = Math.round(wer(fixture.text, transcript) * 1000) / 1000;
      } catch (error) {
        row.wer = null;
        row.werError = String(error && error.code || 'unknown');
      }
    }
    rows.push(row);
  }
  return { rows, whisperReady: whisper.ready };
}

function summarize(rows) {
  const speech = rows.filter((r) => r.kind === 'speech');
  const empty = rows.filter((r) => r.kind === 'empty');
  const boundaryRows = rows.filter((r) => r.startErrMs !== null && r.startErrMs !== undefined);
  const werRows = speech.filter((r) => typeof r.wer === 'number');
  const emptyTurnRate = empty.length ? empty.filter((r) => r.detected).length / empty.length : 0;
  const falseNegativeRate = speech.length ? speech.filter((r) => !r.detected).length / speech.length : 0;
  const truncations = boundaryRows.filter((r) => r.endErrMs !== null && r.endErrMs > TRUNCATION_TOLERANCE_MS).length;
  const startErrs = boundaryRows.map((r) => Math.abs(r.startErrMs)).filter((v) => Number.isFinite(v));
  const endErrs = boundaryRows.map((r) => Math.abs(r.endErrMs)).filter((v) => Number.isFinite(v));
  const mean = (values) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);
  return {
    fixtures: rows.length,
    emptyTurnRate: Math.round(emptyTurnRate * 1000) / 1000,
    falseNegativeRate: Math.round(falseNegativeRate * 1000) / 1000,
    truncationCount: truncations,
    meanStartErrorMs: mean(startErrs),
    meanEndErrorMs: mean(endErrs),
    werMean: werRows.length ? Math.round((werRows.reduce((a, b) => a + b.wer, 0) / werRows.length) * 1000) / 1000 : null,
    werSamples: werRows.length,
  };
}

function printReport(summary, rows, whisperReady) {
  console.log(`\nVAD accuracy evaluation — ${summary.fixtures} fixtures`);
  console.log(`  empty-turn rate:      ${Math.round(summary.emptyTurnRate * 100)}%`);
  console.log(`  false-negative rate:  ${Math.round(summary.falseNegativeRate * 100)}%`);
  console.log(`  truncated utterances: ${summary.truncationCount}`);
  console.log(`  mean boundary error:  start ${summary.meanStartErrorMs} ms, end ${summary.meanEndErrorMs} ms`);
  console.log(`  WER: ${summary.werMean === null ? 'skipped' : `${Math.round(summary.werMean * 100)}% over ${summary.werSamples} samples`}${whisperReady ? '' : ' (set VOLYX_LENS_WHISPER_CLI and VOLYX_LENS_WHISPER_MODEL to include WER)'}`);
  const byCategory = {};
  for (const row of rows) byCategory[row.category] = (byCategory[row.category] || 0) + 1;
  console.log(`\n  categories: ${Object.entries(byCategory).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
  for (const row of rows) {
    const markers = [
      row.kind === 'speech' && !row.detected ? 'MISSED' : null,
      row.kind === 'empty' && row.detected ? 'FALSE-POSITIVE' : null,
      row.forced ? 'FORCED-CAP' : null,
      row.endErrMs !== null && row.endErrMs > TRUNCATION_TOLERANCE_MS ? 'TRUNCATED' : null,
    ].filter(Boolean);
    const werText = row.wer === undefined || row.wer === null ? '' : ` wer=${Math.round(row.wer * 100)}%`;
    console.log(`  ${row.id.padEnd(20)} ${row.category.padEnd(12)} ${String(row.utterances).padStart(2)} utt ${markers.length ? `[${markers.join(', ')}]` : ''}${werText}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const regenerate = args.includes('--regenerate');
  const reportOnly = args.includes('--report');
  if (!reportOnly) {
    const { fixtures, generated, skippedVoices } = await generateAll(regenerate);
    if (skippedVoices) console.log(`Skipped ${skippedVoices} accent fixture(s) whose voice is not installed.`);
    if (generated) console.log(`Generated ${generated} fixture(s) into ${CACHE_DIR}.`);
  }
  const fixtures = buildFixtures().filter((fixture) => {
    if (fixture.kind !== 'speech') return true;
    const voice = fixture.voice || 'Samantha';
    return availableVoices().has(voice);
  });
  const { rows, whisperReady } = await runEvaluation(fixtures);
  const summary = summarize(rows);
  printReport(summary, rows, whisperReady);
  fs.writeFileSync(path.join(CACHE_DIR, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), summary, rows }, null, 2));
  console.log(`\nFull report: ${path.join(CACHE_DIR, 'report.json')}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[vad-eval] ${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  mulberry32,
  decodeWav,
  silencePcm,
  noisePcm,
  scaleToRms,
  mixPcm,
  insertSilenceGap,
  buildFixtures,
  evaluatePcm,
  normalizeText,
  wer,
};
