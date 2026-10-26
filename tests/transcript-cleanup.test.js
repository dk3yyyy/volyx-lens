const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CLEAN_BATCH_TURNS,
  CLEAN_BATCH_CHARACTERS,
  MAX_CLEAN_BATCHES,
  CLEAN_SYSTEM_PROMPT,
  planCleanBatches,
  buildCleanPrompt,
  parseCleanBatch,
  cleanedTurnsFrom,
} = require('../src/transcript-cleanup');

function turns(count, textFor = (index) => `utterance number ${index} with enough words in it`) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    channel: index % 2 === 0 ? 'them' : 'you',
    text: textFor(index),
    ts: 1000 + index * 500,
  }));
}

test('planner batches by turn count and character budget without dropping turns', () => {
  const input = turns(95);
  const plan = planCleanBatches(input);
  assert.equal(plan.requestCount, plan.batches.length);
  assert.ok(plan.batches.length >= 3, 'long meetings split into several requests');
  for (const batch of plan.batches) {
    assert.ok(batch.indices.length <= CLEAN_BATCH_TURNS, 'turn cap respected');
    assert.ok(batch.text.length <= CLEAN_BATCH_CHARACTERS + 400, 'character cap respected');
  }
  const covered = plan.batches.flatMap((batch) => batch.indices);
  assert.deepEqual(covered, input.map((_, index) => index), 'every turn index appears once, in order');
  assert.equal(plan.tooLong, false);
});

test('planner keeps one request for a short meeting and marks nothing as too long', () => {
  const input = turns(6);
  const plan = planCleanBatches(input);
  assert.equal(plan.requestCount, 1);
  assert.equal(plan.tooLong, false);
  assert.equal(plan.batches[0].indices.length, 6);
});

test('planner flags meetings that exceed the request cap instead of silently sampling', () => {
  const input = turns(MAX_CLEAN_BATCHES * CLEAN_BATCH_TURNS + 50);
  const plan = planCleanBatches(input);
  assert.equal(plan.tooLong, true);
  assert.ok(plan.requestCount > MAX_CLEAN_BATCHES);
  assert.equal(plan.batches.length, 0, 'no partial plan is returned when the meeting is too long');
});

test('planner accepts an empty transcript without producing work', () => {
  const plan = planCleanBatches([]);
  assert.equal(plan.requestCount, 0);
  assert.deepEqual(plan.batches, []);
  assert.equal(plan.tooLong, false);
});

test('the prompt tells the model to preserve line count and order and never summarise', () => {
  assert.match(CLEAN_SYSTEM_PROMPT, /same number of lines/i);
  assert.match(CLEAN_SYSTEM_PROMPT, /same order/i);
  assert.match(CLEAN_SYSTEM_PROMPT, /not\b[^.]*summar/i);
  assert.match(CLEAN_SYSTEM_PROMPT, /must not add information/i);
  assert.match(CLEAN_SYSTEM_PROMPT, /leave that word exactly as it arrived/i);

  const plan = planCleanBatches(turns(2));
  const prompt = buildCleanPrompt(plan.batches[0]);
  assert.match(prompt, /\[0\] Them: /);
  assert.match(prompt, /\[1\] You: /);
});

test('parser accepts mechanical fixes and maps them back to the same turns', () => {
  const input = [
    { id: 1, channel: 'them', text: 'so the deprecation of the vee four pro model', ts: 10 },
    { id: 2, channel: 'you', text: 'right and that means the flash model stays the vision one', ts: 20 },
  ];
  const batch = planCleanBatches(input).batches[0];
  const reply = [
    '[0] Them: So the deprecation of the V4 Pro model.',
    '[1] You: Right, and that means the Flash model stays the vision one.',
  ].join('\n');
  const result = parseCleanBatch(reply, batch);
  assert.equal(result.accepted.size, 2);
  assert.equal(result.accepted.get(0), 'So the deprecation of the V4 Pro model.');
  assert.equal(result.accepted.get(1), 'Right, and that means the Flash model stays the vision one.');
  assert.deepEqual(result.missing, []);
});

test('parser rejects a line that swapped a rewrite for a cleanup', () => {
  const input = [
    { id: 1, channel: 'them', text: 'so the point I keep making about the migration timeline is that we cannot move it twice in the same quarter because the team will burn out', ts: 10 },
    { id: 2, channel: 'you', text: 'let me pull the numbers on that before we commit to anything', ts: 20 },
  ];
  const batch = planCleanBatches(input).batches[0];
  const reply = [
    '[0] Them: They cannot migrate twice a quarter.',
    '[1] You: Let me pull the numbers on that before we commit to anything.',
  ].join('\n');
  const result = parseCleanBatch(reply, batch);
  assert.equal(result.accepted.has(0), false, 'summarised line is rejected');
  assert.equal(result.rejected[0].index, 0);
  assert.match(result.rejected[0].reason, /length/);
  assert.equal(result.accepted.get(1), 'Let me pull the numbers on that before we commit to anything.');
});

test('parser rejects invented padding longer than the spoken turn', () => {
  const input = [{ id: 1, channel: 'them', text: 'ship it friday', ts: 10 }];
  const batch = planCleanBatches(input).batches[0];
  const reply = '[0] Them: Ship it Friday, and then monitor the deploy closely while telling the whole team about the rollout plan.';
  const result = parseCleanBatch(reply, batch);
  assert.equal(result.accepted.has(0), false);
  assert.match(result.rejected[0].reason, /length/);
});

test('parser keeps raw text for lines the model omitted and ignores unknown markers', () => {
  const input = turns(3);
  const batch = planCleanBatches(input).batches[0];
  const reply = [
    '[0] Them: Utterance number 0 with enough words in it.',
    '[7] Them: This marker was never sent.',
  ].join('\n');
  const result = parseCleanBatch(reply, batch);
  assert.equal(result.accepted.size, 1);
  assert.deepEqual(result.missing, [1, 2]);
  assert.equal(result.accepted.has(7), false, 'unknown marker ignored');
});

test('parser tolerates code fences and an echoed speaker label the model added', () => {
  const input = [{ id: 1, channel: 'you', text: 'can you hear me now', ts: 10 }];
  const batch = planCleanBatches(input).batches[0];
  const reply = ['```', '[0] You: Can you hear me now?', '```'].join('\n');
  const result = parseCleanBatch(reply, batch);
  assert.equal(result.accepted.get(0), 'Can you hear me now?');
});

test('cleanedTurnsFrom builds a parallel array that falls back to raw per turn', () => {
  const input = turns(4);
  const accepted = new Map([
    [1, 'Utterance number one, with enough words in it.'],
    [3, 'Utterance number three, with enough words in it.'],
  ]);
  const cleaned = cleanedTurnsFrom(input, accepted);
  assert.equal(cleaned.length, input.length);
  assert.deepEqual(cleaned.map((turn) => turn.channel), input.map((turn) => turn.channel));
  assert.deepEqual(cleaned.map((turn) => turn.ts), input.map((turn) => turn.ts));
  assert.equal(cleaned[0].text, input[0].text, 'uncleaned turn keeps raw text');
  assert.equal(cleaned[1].text, 'Utterance number one, with enough words in it.');
  assert.equal(cleaned[2].text, input[2].text);
  assert.equal(cleaned[3].text, 'Utterance number three, with enough words in it.');
});
