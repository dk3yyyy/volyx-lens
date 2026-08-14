'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { buildSttVocab, looksLikeHallucination, filterTranscript, extractDomainTerms, BASE_STT_VOCAB } = require('../src/transcript-hygiene');
const { createSTT } = require('../src/stt');
const { runWhisperCli } = require('../src/offline-stt');

test('looksLikeHallucination drops whisper silence artifacts', () => {
  for (const s of ['', '   ', '👍👍', 'thanks for watching', 'Thank you for watching!', 'thank you for listening', 'please like and subscribe', 'subscribe to my channel', 'like and subscribe']) {
    assert.equal(looksLikeHallucination(s), true, JSON.stringify(s));
  }
});

test('looksLikeHallucination keeps real speech, including short meeting turns', () => {
  for (const s of ['Tell me about your experience with Kubernetes.', 'The budget is forty two thousand three hundred and ten dollars.', 'Okay, I think we should move forward.', 'hello', 'Thanks for the update.', 'You', 'Thank you.', 'Thank you very much.', 'Bye-bye.', 'bye bye', 'See you next time.', 'Please subscribe to the roadmap doc.']) {
    assert.equal(looksLikeHallucination(s), false, JSON.stringify(s));
  }
});

test('extractDomainTerms keeps names, acronyms, and model ids, in order, deduped', () => {
  const terms = extractDomainTerms('Optum EKS Terraform AWS SRE nova-3 nova-3 gpt-4o-mini-transcribe');
  assert.deepEqual(terms, ['Optum', 'EKS', 'Terraform', 'AWS', 'SRE', 'nova-3', 'gpt-4o-mini-transcribe']);
  // All-lowercase words without digits (e.g. a lowercase "deepgram") are
  // deliberately not extracted — they are indistinguishable from common words.
  assert.deepEqual(extractDomainTerms('deepgram whisper'), []);
});

test('extractDomainTerms excludes stop words and number words', () => {
  const terms = extractDomainTerms('The budget is forty two thousand three hundred and ten dollars for the new FY26 plan.');
  for (const t of terms) {
    assert.notEqual(t.toLowerCase(), 'the');
    assert.notEqual(t.toLowerCase(), 'forty');
    assert.notEqual(t.toLowerCase(), 'dollars');
  }
  assert.ok(terms.includes('FY26'), 'acronym with a digit is kept');
});

test('buildSttVocab prepends the base vocabulary and caps the total length', () => {
  const vocab = buildSttVocab({ personalContext: 'Optum EKS Terraform AWS SRE nova-3 gpt-4o-mini-transcribe'.repeat(20) });
  assert.ok(vocab.startsWith(BASE_STT_VOCAB.split(',')[0]));
  assert.ok(vocab.includes('Optum'));
  assert.ok(vocab.includes('nova-3'));
  assert.ok(vocab.length <= 900);
  assert.ok(!/, $/.test(vocab), 'no dangling comma');
});

test('buildSttVocab with empty context returns the base vocabulary', () => {
  assert.equal(buildSttVocab({}), BASE_STT_VOCAB);
  assert.equal(buildSttVocab({ personalContext: '' }), BASE_STT_VOCAB);
});

test('filterTranscript returns empty for artifacts and trimmed text otherwise', () => {
  assert.equal(filterTranscript('  Thank you for watching. '), '');
  assert.equal(filterTranscript('  hello there  '), 'hello there');
});

async function whisperFixture() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'volyx-lens-hygiene-test-'));
  const executable = path.join(dir, 'whisper-cli');
  const model = path.join(dir, 'model.bin');
  await fs.promises.writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await fs.promises.writeFile(model, 'model');
  return { dir, executable, model, env: { VOLYX_LENS_WHISPER_CLI: executable, VOLYX_LENS_WHISPER_MODEL: model } };
}

test('offline whisper adapter passes the domain-term seed as --prompt', async () => {
  const item = await whisperFixture();
  let sawPrompt = false;
  try {
    await runWhisperCli({
      executable: item.executable,
      model: item.model,
      wav: Buffer.from('RIFF-test'),
      prompt: 'gpt-realtime-whisper, nova-3',
      spawnImpl(executable, args) {
        const index = args.indexOf('--prompt');
        sawPrompt = index !== -1 && args[index + 1] === 'gpt-realtime-whisper, nova-3';
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => child.emit('close', null, 'SIGKILL');
        const outputPrefix = args[args.indexOf('--output-file') + 1];
        setImmediate(async () => {
          await fs.promises.writeFile(`${outputPrefix}.txt`, 'local transcript');
          child.emit('close', 0, null);
        });
        return child;
      },
    });
    assert.equal(sawPrompt, true);
  } finally { await fs.promises.rm(item.dir, { recursive: true, force: true }); }
});

test('createSTT forwards the vocab prompt to the OpenAI and offline adapters', async () => {
  const item = await whisperFixture();
  const seen = [];
  try {
    const openaiStt = createSTT({ apiKeys: { openai: 'k' } }, {
      env: {},
      vocab: 'nova-3, EKS',
      openAITranscribe: async (key, wav, model, prompt) => { seen.push(['openai', prompt]); return 'real text'; },
    });
    const offlineStt = createSTT({ transcription: { offlineEnabled: true }, apiKeys: {} }, {
      env: item.env,
      vocab: 'nova-3, EKS',
      offlineTranscribe: async (wav, options) => { seen.push(['offline', options.prompt]); return 'real text'; },
    });
    await openaiStt.transcribe(Buffer.alloc(4000, 1));
    await offlineStt.transcribe(Buffer.alloc(4000, 1));
    assert.deepEqual(seen, [['openai', 'nova-3, EKS'], ['offline', 'nova-3, EKS']]);
  } finally { await fs.promises.rm(item.dir, { recursive: true, force: true }); }
});

test('createSTT drops whisper silence artifacts instead of emitting phantom rows', async () => {
  const stt = createSTT({ apiKeys: { openai: 'k' } }, {
    env: {},
    openAITranscribe: async () => 'Thank you for watching.',
  });
  const result = await stt.transcribe(Buffer.alloc(4000, 1));
  assert.deepEqual(result, { text: '', provider: 'openai' });
});

test('real transcribeOpenAI uploads the audio file and forwards the vocab prompt', async () => {
  const originalLoad = Module._load;
  const createCalls = [];
  let uploaded;
  Module._load = function load(request, parent, isMain) {
    if (request === 'openai') {
      return class FakeOpenAI {
        static toFile = async (wav, filename, options) => { uploaded = { wav, filename, options }; return { kind: 'file' }; };
        constructor() {
          this.audio = { transcriptions: { create: async (body) => { createCalls.push(body); return { text: 'hello world' }; } } };
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const stt = createSTT({ apiKeys: { openai: 'k' } }, { env: {}, vocab: 'nova-3, EKS' });
    const result = await stt.transcribe(Buffer.alloc(4000, 1));
    assert.deepEqual(result, { text: 'hello world', provider: 'openai' });
    assert.equal(uploaded.filename, 'audio.wav');
    assert.deepEqual(uploaded.options, { type: 'audio/wav' });
    assert.equal(createCalls.length, 1);
    assert.deepEqual(createCalls[0].file, { kind: 'file' });
    assert.equal(createCalls[0].model, 'gpt-4o-mini-transcribe');
    assert.equal(createCalls[0].prompt, 'nova-3, EKS');
  } finally {
    Module._load = originalLoad;
  }
});

test('real transcribeOpenAI omits the prompt when no vocab is configured', async () => {
  const originalLoad = Module._load;
  const createCalls = [];
  Module._load = function load(request, parent, isMain) {
    if (request === 'openai') {
      return class FakeOpenAI {
        static toFile = async () => ({ kind: 'file' });
        constructor() {
          this.audio = { transcriptions: { create: async (body) => { createCalls.push(body); return { text: 'hello world' }; } } };
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const stt = createSTT({ apiKeys: { openai: 'k' } }, { env: {} });
    await stt.transcribe(Buffer.alloc(4000, 1));
    assert.equal('prompt' in createCalls[0], false);
  } finally {
    Module._load = originalLoad;
  }
});
