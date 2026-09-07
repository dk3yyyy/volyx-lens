const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  createLinuxMonitorCapture,
  findMonitorSource,
  parseDefaultSink,
  downmixStereoPcm,
  MONO_BYTES_PER_CHUNK,
  STEREO_BYTES_PER_CHUNK,
} = require('../src/linux-monitor-capture');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kills = [];
  child.kill = (signal) => { child.kills.push(signal); };
  return child;
}

function pcm16Pair(left, right) {
  const buf = Buffer.alloc(4);
  buf.writeInt16LE(left, 0);
  buf.writeInt16LE(right, 2);
  return buf;
}

// Spawns pactl children that answer canned discovery output and captures any
// parec child so the test can feed audio into it. pactl replies can be
// deferred to exercise timeout/stop races.
function discoverySpawn(sink, { pactlDelayMs = 0, hang = false, parecSpawnError = null } = {}) {
  const calls = [];
  const spawned = { pactl: [], parec: [] };
  return {
    spawn: (command, args) => {
      calls.push({ command, args });
      const child = fakeChild();
      if (command === 'pactl') {
        spawned.pactl.push(child);
        const output = args.includes('get-default-sink')
          ? `${sink || ''}\n`
          : (sink ? `0\t${sink}.monitor\tmodule-alsa-card.c\ts16le 2ch 44100Hz\tIDLE\n` : '');
        const reply = () => {
          if (hang) return;
          child.stdout.end(output);
          child.emit('close', 0, null);
        };
        if (pactlDelayMs > 0) setTimeout(reply, pactlDelayMs);
        else setImmediate(reply);
      } else if (command === 'parec') {
        spawned.parec.push(child);
        if (parecSpawnError) {
          const error = new Error(parecSpawnError.message);
          error.code = parecSpawnError.code;
          setImmediate(() => child.emit('error', error));
        } else {
          setImmediate(() => child.emit('spawn'));
        }
      }
      return child;
    },
    calls,
    spawned,
  };
}

test('linux monitor discovery parses the default sink and requires its exact monitor', () => {
  const sink = 'alsa_output.pci-0000_00_1f.3.analog-stereo';
  assert.equal(parseDefaultSink(`${sink}\n`), sink);
  const sources = [
    '0\talsa_output.pci-0000_00_1f.3.analog-stereo.monitor\tmodule-alsa-card.c\ts16le 2ch 44100Hz\tIDLE',
    '1\talsa_input.pci-0000_00_1f.3.analog-stereo\tmodule-alsa-card.c\ts16le 2ch 44100Hz\tRUNNING',
  ].join('\n');
  assert.equal(findMonitorSource(sources, sink), `${sink}.monitor`);
  // Never fall back to another sink's monitor: that would record the wrong
  // output (e.g. HDMI while the default is headphones).
  assert.equal(findMonitorSource(sources, 'missing-sink'), null);
  assert.equal(findMonitorSource('', sink), null);
});

test('stereo s16le downmix produces the rounded mean of each channel pair', () => {
  const stereo = Buffer.concat([
    pcm16Pair(1000, 2000),
    pcm16Pair(-1000, -2000),
    pcm16Pair(3000, 3000),
    pcm16Pair(-32768, 32767),
  ]);
  const mono = downmixStereoPcm(stereo);
  assert.equal(mono.length, 8);
  assert.equal(mono.readInt16LE(0), 1500);
  assert.equal(mono.readInt16LE(2), -1500);
  assert.equal(mono.readInt16LE(4), 3000);
  // Mean -0.5 rounds to +0 (writeInt16LE(-0) stores 0x0000).
  assert.equal(mono.readInt16LE(6), 0);
});

test('linux controller runs pactl discovery and streams downmixed mono chunks', async () => {
  const sink = 'alsa_output.pci-0000_00_1f.3.analog-stereo';
  const fake = discoverySpawn(sink);
  const chunks = [];
  const states = [];
  const controller = createLinuxMonitorCapture({
    platform: 'linux',
    spawnImpl: fake.spawn,
    onPcm: (chunk) => chunks.push(chunk),
    onState: (state) => states.push(state),
  });
  const started = await controller.start();
  assert.deepEqual(started, { ok: true });
  assert.equal(fake.spawned.parec.length, 1);
  const parecArgs = fake.calls.find((call) => call.command === 'parec').args;
  assert.ok(parecArgs.some((arg) => arg.includes(sink)), 'device monitor selected');
  assert.ok(parecArgs.includes('--rate=24000'));
  assert.ok(parecArgs.includes('--channels=2'));
  assert.equal(states.some((state) => state.state === 'ready'), true);

  // Feed one 20 ms stereo chunk where every pair is L=1200 R=1800 (mono 1500).
  const parec = fake.spawned.parec[0];
  const stereoChunk = Buffer.alloc(STEREO_BYTES_PER_CHUNK);
  for (let i = 0; i < STEREO_BYTES_PER_CHUNK; i += 4) {
    stereoChunk.writeInt16LE(1200, i);
    stereoChunk.writeInt16LE(1800, i + 2);
  }
  parec.stdout.write(stereoChunk.subarray(0, 511));
  parec.stdout.write(stereoChunk.subarray(511));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].length, MONO_BYTES_PER_CHUNK);
  assert.equal(chunks[0].readInt16LE(0), 1500);
});

test('linux controller reports missing tools and absent monitors as clear failures', async () => {
  const missing = createLinuxMonitorCapture({
    platform: 'linux',
    spawnImpl: () => { const error = new Error('spawn ENOENT'); error.code = 'ENOENT'; throw error; },
  });
  const toolResult = await missing.start();
  assert.equal(toolResult.ok, false);
  assert.equal(toolResult.reason, 'tool_missing');

  const noSinkFake = discoverySpawn('');
  const noSink = createLinuxMonitorCapture({ platform: 'linux', spawnImpl: noSinkFake.spawn });
  const noSinkResult = await noSink.start();
  assert.equal(noSinkResult.ok, false);
  assert.equal(noSinkResult.reason, 'no_default_sink');
});

test('a parec spawn error surfaces as tool_missing instead of a false ready', async () => {
  const sink = 'alsa_output.pci-0000_00_1f.3.analog-stereo';
  const fake = discoverySpawn(sink, { parecSpawnError: { message: 'spawn ENOENT', code: 'ENOENT' } });
  const states = [];
  const controller = createLinuxMonitorCapture({
    platform: 'linux',
    spawnImpl: fake.spawn,
    onState: (state) => states.push(state),
  });
  const result = await controller.start();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'tool_missing');
  assert.equal(states.at(-1).state, 'failed');
});

test('a hung pactl discovery times out instead of leaving start pending', async () => {
  const fake = discoverySpawn('sink', { hang: true });
  const controller = createLinuxMonitorCapture({
    platform: 'linux',
    spawnImpl: fake.spawn,
    readyTimeoutMs: 60,
  });
  const startedAt = Date.now();
  const result = await controller.start();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ready_timeout');
  assert.ok(Date.now() - startedAt < 2000, 'timeout resolved promptly');
  assert.equal(fake.spawned.parec.length, 0);
});

test('stop during discovery invalidates a late parec spawn', async () => {
  const sink = 'alsa_output.pci-0000_00_1f.3.analog-stereo';
  const fake = discoverySpawn(sink, { pactlDelayMs: 40 });
  const states = [];
  const controller = createLinuxMonitorCapture({
    platform: 'linux',
    spawnImpl: fake.spawn,
    onState: (state) => states.push(state),
    readyTimeoutMs: 5000,
  });
  const started = controller.start();
  await controller.stop({ immediate: true });
  const result = await started;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'superseded');
  assert.equal(fake.spawned.parec.length, 0, 'no parec spawns after stop');
});

test('linux controller stops the parec child and ignores its later exit', async () => {
  const sink = 'alsa_output.pci-0000_00_1f.3.analog-stereo';
  const fake = discoverySpawn(sink);
  const states = [];
  const exits = [];
  const controller = createLinuxMonitorCapture({
    platform: 'linux',
    spawnImpl: fake.spawn,
    onState: (state) => states.push(state),
    onUnexpectedExit: (event) => exits.push(event),
  });
  await controller.start();
  const child = fake.spawned.parec[0];
  await controller.stop({ immediate: true });
  assert.ok(child.kills.length >= 1, 'parec child killed on stop');

  // The child emits close asynchronously after the kill; only then is the
  // controller's stopped state reported, and never as an unexpected exit.
  child.emit('close', 143, null);
  assert.equal(states.at(-1).state, 'stopped');
  assert.equal(exits.length, 0, 'intentional stop does not report unexpected exit');
});
