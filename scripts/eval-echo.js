#!/usr/bin/env node
'use strict';

// Synthetic speaker-echo evaluation for src/acoustic-echo-filter.js.
//
//   node scripts/eval-echo.js            # compare double-talk modes
//   node scripts/eval-echo.js --json     # machine-readable output
//   node scripts/eval-echo.js --check    # exit 1 if the default filter drops
//                                        # any chunk where you are as loud as the echo
//   EVAL_MODES='[{"name":"x","options":{...}}]' node scripts/eval-echo.js
//                                        # compare your own filter options
//
// Signals are generated, never recorded: speech-like noise with a syllabic
// envelope, a delayed attenuated speaker echo, optional room reflections and a
// diffuse tail, plus the user's voice at several levels relative to the echo.
// Each 2048-sample mic chunk is labelled with ground truth from the separate
// tracks, so the report counts echo removed and the user's speech dropped.
//
// These numbers rank designs against each other. They are not tuned values for
// real rooms: real laptops add speaker distortion, browser AGC/NS and room
// acoustics this model does not have. Tune against recorded sessions.

const { createAcousticEchoFilter } = require('../src/acoustic-echo-filter');

const SAMPLE_RATE = 24000;
const CHUNK = 2048;
const LEAD_SAMPLES = Math.round(SAMPLE_RATE * 0.25); // MicEchoCoordinator delay
const DURATION_S = 12;
const ECHO_DELAY_MS = 60;
const ECHO_GAIN = 0.25; // about -12 dB from playback to mic

const ROOMS = [
  { name: 'dry', reflections: [], tail: null },
  { name: 'small room', reflections: [[9, 0.5], [23, 0.35], [41, 0.25]], tail: { delayMs: 37, feedback: 0.45, gain: 0.2 } },
  { name: 'reverberant room', reflections: [[7, 0.7], [19, 0.6], [33, 0.5], [52, 0.4], [77, 0.3]], tail: { delayMs: 43, feedback: 0.7, gain: 0.45 } },
];

const MODES = process.env.EVAL_MODES ? JSON.parse(process.env.EVAL_MODES) : [
  { name: 'correlation only (main a22f989)', options: { doubleTalkMode: 'residual', localResidualShareThreshold: 2, localFrameMarginDb: 99 } },
  { name: 'waveform residual (default)', options: {} },
  { name: 'envelope (experimental)', options: { doubleTalkMode: 'envelope' } },
];

function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return (state / 0xffffffff) * 2 - 1;
  };
}

function speech(seconds, seed, rate) {
  const random = makeRandom(seed);
  const length = Math.round(seconds * SAMPLE_RATE);
  const output = new Float64Array(length);
  let y1 = 0;
  let y2 = 0;
  for (let index = 0; index < length; index += 1) {
    const y = random() + 1.6 * y1 - 0.8 * y2;
    y2 = y1;
    y1 = y;
    const time = index / SAMPLE_RATE;
    const syllables = Math.pow(Math.max(0, Math.sin(2 * Math.PI * rate * time + seed)), 1.5);
    const phrases = 0.6 + 0.4 * Math.sin(2 * Math.PI * 0.3 * time + seed);
    output[index] = y * syllables * phrases;
  }
  return output;
}

function rms(signal, start = 0, end = signal.length) {
  let sum = 0;
  for (let index = start; index < end; index += 1) sum += signal[index] * signal[index];
  return Math.sqrt(sum / Math.max(1, end - start));
}

function scaleTo(signal, target) {
  const factor = target / (rms(signal) || 1);
  return signal.map((value) => value * factor);
}

function roomEcho(source, room) {
  const taps = [[ECHO_DELAY_MS, 1], ...room.reflections.map(([ms, gain]) => [ECHO_DELAY_MS + ms, gain])];
  const output = new Float64Array(source.length);
  for (const [ms, gain] of taps) {
    const delay = Math.round(SAMPLE_RATE * ms / 1000);
    for (let index = delay; index < source.length; index += 1) output[index] += source[index - delay] * gain * ECHO_GAIN;
  }
  if (room.tail) {
    const delay = Math.round(SAMPLE_RATE * room.tail.delayMs / 1000);
    const comb = new Float64Array(source.length);
    const start = Math.round(SAMPLE_RATE * ECHO_DELAY_MS / 1000);
    for (let index = start; index < source.length; index += 1) {
      comb[index] = source[index - start] + (index >= delay ? room.tail.feedback * comb[index - delay] : 0);
      output[index] += comb[index] * room.tail.gain * ECHO_GAIN * 0.3;
    }
  }
  return output;
}

function toPcm(signal) {
  const pcm = Buffer.alloc(signal.length * 2);
  for (let index = 0; index < signal.length; index += 1) {
    const value = Math.max(-1, Math.min(1, signal[index]));
    pcm.writeInt16LE(Math.round(value < 0 ? value * 0x8000 : value * 0x7fff), index * 2);
  }
  return pcm;
}

function add(...signals) {
  const output = new Float64Array(signals[0].length);
  for (const signal of signals) for (let index = 0; index < output.length; index += 1) output[index] += signal[index];
  return output;
}

function evaluate(options, system, microphone, echo, user) {
  const filter = createAcousticEchoFilter({ sampleRate: SAMPLE_RATE, ...options });
  const counts = { echoOnly: 0, echoRemoved: 0, loud: 0, loudDropped: 0, quiet: 0, quietDropped: 0 };
  let fed = 0;
  for (let start = 0; start + CHUNK <= microphone.length; start += CHUNK) {
    const referenceEnd = Math.min(system.length, start + CHUNK + LEAD_SAMPLES);
    while (fed < referenceEnd) {
      const next = Math.min(referenceEnd, fed + CHUNK);
      filter.observeSystem(toPcm(system.subarray(fed, next)));
      fed = next;
    }
    const { suppress } = filter.inspectMicrophone(toPcm(microphone.subarray(start, start + CHUNK)));
    const echoLevel = echo ? rms(echo, start, start + CHUNK) : 0;
    const userLevel = user ? rms(user, start, start + CHUNK) : 0;
    if (echoLevel > 0.004 && userLevel < 0.1 * echoLevel) {
      counts.echoOnly += 1;
      if (suppress) counts.echoRemoved += 1;
    } else if (userLevel > 0.006 && userLevel >= echoLevel) {
      counts.loud += 1;
      if (suppress) counts.loudDropped += 1;
    } else if (userLevel > 0.006 && userLevel >= 0.5 * echoLevel) {
      counts.quiet += 1;
      if (suppress) counts.quietDropped += 1;
    }
  }
  return counts;
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + row[key], 0);
}

function share(part, whole) {
  return whole ? part / whole : null;
}

function main() {
  const json = process.argv.includes('--json');
  const check = process.argv.includes('--check');
  const remote = scaleTo(speech(DURATION_S, 11, 3.7), 0.1);
  const local = speech(DURATION_S, 29, 4.3);
  const noiseRandom = makeRandom(97);
  const noise = new Float64Array(remote.length).map(() => noiseRandom() * 0.0017);
  const silent = new Float64Array(remote.length);

  const report = [];
  for (const mode of MODES) {
    const perRoom = [];
    for (const room of ROOMS) {
      const echo = roomEcho(remote, room);
      const rows = [evaluate(mode.options, remote, add(echo, noise), echo, null)];
      for (const level of [0.5, 0.7, 1, 2]) {
        const user = scaleTo(local, rms(echo) * level);
        rows.push(evaluate(mode.options, remote, add(echo, noise, user), echo, user));
      }
      const alone = scaleTo(local, 0.05);
      rows.push(evaluate(mode.options, silent, add(alone, noise), null, alone));
      perRoom.push({
        room: room.name,
        echoRemoved: share(sum(rows, 'echoRemoved'), sum(rows, 'echoOnly')),
        loudDropped: share(sum(rows, 'loudDropped'), sum(rows, 'loud')),
        quietDropped: share(sum(rows, 'quietDropped'), sum(rows, 'quiet')),
      });
    }
    report.push({ mode: mode.name, rooms: perRoom });
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const pct = (value) => (value === null ? '   -  ' : `${(value * 100).toFixed(1).padStart(5)}%`);
    for (const entry of report) {
      process.stdout.write(`\n${entry.mode}\n`);
      process.stdout.write('  room               echo removed   you >= echo dropped   you 0.5-1x echo dropped\n');
      for (const room of entry.rooms) {
        process.stdout.write(`  ${room.room.padEnd(18)} ${pct(room.echoRemoved)}         ${pct(room.loudDropped)}                ${pct(room.quietDropped)}\n`);
      }
    }
    process.stdout.write('\nSynthetic signals only: use these to compare designs, not as tuned thresholds.\n');
  }

  if (check) {
    const defaults = report.find((entry) => entry.mode === 'waveform residual (default)') || report[0];
    const failed = defaults.rooms.filter((room) => room.loudDropped !== null && room.loudDropped > 0);
    if (failed.length) {
      process.stderr.write(`eval-echo: default filter dropped speech louder than the echo in ${failed.map((room) => room.room).join(', ')}\n`);
      process.exitCode = 1;
    }
  }
}

main();
