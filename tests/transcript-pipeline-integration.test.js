'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

test('confirmed transcript processing is centralized and snapshotted per pipeline run', () => {
  assert.match(main, /postProcessTranscript\(text, processingOptions\)/);
  assert.match(main, /parseTranscriptRules\(transcription\.transcriptRules\)/);
  assert.match(main, /const processingOptions = transcriptProcessingOptions;/);
  assert.match(main, /recordTranscript\(\{ channel, text: res\.text \}, generation, epoch, processingOptions\)/);
  assert.doesNotMatch(main, /const clean = normalizeSpokenDigits/);
  assert.match(main, /rawText: processed\.changed \? processed\.rawText : undefined/);
  assert.match(main, /function removeTranscriptSegment\(segment\)[\s\S]{0,1000}joinRawTranscriptSegments\(turn\.segments\)/);
});

test('custom vocabulary is wired into both batch and realtime recognition prompts', () => {
  assert.match(main, /customVocabulary: activeCustomVocabulary/);
  assert.match(main, /activeCustomVocabulary = transcription\.customVocabulary \|\| ''/);
  assert.match(main, /const customVocabulary = activeCustomVocabulary;/);
});

test('saved history can surface original recognizer wording beside processed text', () => {
  assert.match(renderer, /turn\.rawText \? \{ \.\.\.turn, text: turn\.rawText \} : turn/);
  assert.match(renderer, /function hasOriginalWording\(\)/);
  assert.match(renderer, /meeting-view-toggle'\)\.addEventListener\('click'[\s\S]{0,220}\(!hasCleanedView\(\) && !hasOriginalWording\(\)\)/);
});

test('fresh history turns retain original recognizer wording when processing changed it', () => {
  assert.match(main, /const rawText = joinRawTranscriptSegments\(fresh\)/);
  assert.match(main, /rawText: rawText && rawText !== text \? rawText : undefined/);
});
