'use strict';

// The Whisper picker must only offer models that can actually be downloaded.
// Every <option> value is fed to fileFor(); anything with no published file, or
// anything in UNAVAILABLE, must not be selectable.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { fileFor, unavailableReason } = require('../src/whisper-models');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');

function whisperSelectOptions() {
  const match = html.match(/<select id="stt-whisper-model">([\s\S]*?)<\/select>/);
  assert.ok(match, 'renderer/index.html has a <select id="stt-whisper-model">');
  const options = [];
  const optionPattern = /<option\s+value="([^"]+)"([^>]*)>([^<]*)<\/option>/g;
  let entry;
  while ((entry = optionPattern.exec(match[1])) !== null) {
    options.push({
      value: entry[1],
      attributes: entry[2],
      label: entry[3].trim(),
    });
  }
  return options;
}

test('the whisper model picker is present and offers a sane number of models', () => {
  const options = whisperSelectOptions();
  assert.equal(options.length, 16);
  assert.equal(new Set(options.map((option) => option.value)).size, options.length, 'option values are unique');
});

test('every offered whisper model has a published file', () => {
  for (const option of whisperSelectOptions()) {
    const entry = fileFor(option.value);
    assert.ok(entry, `${option.value} is offered but fileFor() returned null`);
    assert.match(entry.file, /^ggml-.+\.bin$/, `${option.value} points at a whisper.cpp model file`);
    assert.ok(entry.bytes > 0, `${option.value} has a published byte size`);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${option.value} has a published SHA-256`);
  }
});

test('unavailable whisper models are absent from the picker', () => {
  const values = whisperSelectOptions().map((option) => option.value);
  for (const value of values) {
    assert.equal(unavailableReason(value), '', `${value} is explicitly unavailable but still offered`);
    assert.notEqual(fileFor(value), null, `${value} has no published file but is still offered`);
  }
  assert.equal(values.includes('large-v3.en'), false, 'large-v3.en must not be offered');
  assert.equal(values.includes('distil-large-v3'), false, 'distil-large-v3 must not be offered');
});

test('quantized multilingual files are not labelled English-only', () => {
  const options = new Map(whisperSelectOptions().map((option) => [option.value, option]));
  const multilingualQuantized = ['tiny.int8', 'base.int8', 'small.int8', 'medium.int8', 'large-v3.int8', 'large.int8'];
  for (const value of multilingualQuantized) {
    const option = options.get(value);
    assert.ok(option, `${value} is offered`);
    assert.doesNotMatch(option.label, /English-only/i, `${value} is multilingual and must not say English-only`);
    assert.match(option.label, /multilingual/i, `${value} label says multilingual`);
    assert.match(option.label, /quantized/i, `${value} label says quantized`);
  }
});

test('the large-v3 quantized entry names the q5_0 file it actually downloads', () => {
  const option = whisperSelectOptions().find((entry) => entry.value === 'large-v3.int8');
  assert.ok(option, 'large-v3.int8 is offered');
  assert.match(fileFor('large-v3.int8').file, /q5_0\.bin$/);
  assert.match(option.label, /q5_0/);
  const description = option.label.slice(option.label.indexOf('('));
  assert.doesNotMatch(description, /int8/i);
});

test('English-only files keep their English-only labels', () => {
  const options = new Map(whisperSelectOptions().map((option) => [option.value, option]));
  for (const value of ['tiny.en', 'base.en', 'small.en', 'medium.en']) {
    const option = options.get(value);
    assert.ok(option, `${value} is offered`);
    assert.match(option.label, /English-only/i, `${value} label says English-only`);
  }
});

test('base.en stays the default model', () => {
  const options = whisperSelectOptions();
  const selected = options.filter((option) => /\bselected\b/.test(option.attributes));
  assert.equal(selected.length, 1, 'exactly one option is selected');
  assert.equal(selected[0].value, 'base.en');
  assert.match(renderer, /\$\('#stt-whisper-model'\)\.value = transcription\.whisperModel \|\| 'base\.en';/);
});
