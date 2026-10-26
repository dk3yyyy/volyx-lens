const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CLEAN_BATCH_TURNS,
  CLEAN_BATCH_CHARACTERS,
  MAX_CLEAN_BATCHES,
  MIN_SHORT_TURN_CHARS,
  CLEAN_SYSTEM_PROMPT,
  planCleanBatches,
  buildCleanPrompt,
  parseCleanBatch,
  fidelityIssue,
  collapseRepeatedTokens,
  cleanedTextsFrom,
} = require('../src/transcript-cleanup');

function turns(count, textFor = (index) => `utterance number ${index} with enough words in it`) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    channel: index % 2 === 0 ? 'them' : 'you',
    text: textFor(index),
    ts: 1000 + index * 500,
  }));
}

function reply(lines) {
  return lines.join('\n');
}

test('planner covers every turn exactly once, in order, across bounded batches', () => {
  const input = turns(250);
  const plan = planCleanBatches(input);
  assert.equal(plan.requestCount, plan.batches.length);
  assert.ok(plan.batches.length >= 3, 'a long meeting splits into several requests');
  for (const batch of plan.batches) {
    assert.ok(batch.indices.length <= CLEAN_BATCH_TURNS, 'turn cap respected');
    assert.ok(batch.text.length <= CLEAN_BATCH_CHARACTERS + 400, 'character cap respected');
    assert.ok(batch.maxTokens > 300, 'each batch declares an output budget');
  }
  const covered = plan.batches.flatMap((batch) => batch.indices);
  assert.deepEqual(covered, input.map((_, index) => index), 'every turn index appears once, in order');
  assert.equal(plan.tooLong, false);
  assert.equal(plan.turnsCovered, 250);
});

test('planner splits on the character budget as well as the turn count', () => {
  const input = turns(30);
  const plan = planCleanBatches(input, { charLimit: 600 });
  assert.ok(plan.batches.length > 1, 'character budget forces multiple batches');
  for (const batch of plan.batches) assert.ok(batch.text.length <= 700);
  assert.deepEqual(plan.batches.flatMap((batch) => batch.indices), input.map((_, index) => index));
});

test('planner keeps one request for a short meeting', () => {
  const plan = planCleanBatches(turns(6));
  assert.equal(plan.requestCount, 1);
  assert.equal(plan.tooLong, false);
  assert.equal(plan.batches[0].indices.length, 6);
});

test('planner refuses a meeting past the request cap instead of sampling it', () => {
  const input = turns(MAX_CLEAN_BATCHES * CLEAN_BATCH_TURNS + 50);
  const plan = planCleanBatches(input);
  assert.equal(plan.tooLong, true);
  assert.ok(plan.requestCount > MAX_CLEAN_BATCHES);
  assert.equal(plan.batches.length, 0, 'no partial plan is returned when the meeting is too long');
  assert.equal(plan.turnsCovered, 0, 'partial coverage is never reported as coverage');
});

test('planner accepts an empty transcript without producing work', () => {
  const plan = planCleanBatches([]);
  assert.equal(plan.requestCount, 0);
  assert.deepEqual(plan.batches, []);
  assert.equal(plan.tooLong, false);
});

test('the prompt fixes identity, forbids rewriting, and protects numbers and negations', () => {
  assert.match(CLEAN_SYSTEM_PROMPT, /same number of lines/i);
  assert.match(CLEAN_SYSTEM_PROMPT, /same order/i);
  assert.match(CLEAN_SYSTEM_PROMPT, /not\b[^.]*summar/i);
  assert.match(CLEAN_SYSTEM_PROMPT, /must not add information/i);
  assert.match(CLEAN_SYSTEM_PROMPT, /leave that word exactly as it arrived/i);
  assert.match(CLEAN_SYSTEM_PROMPT, /never turn a spoken number into digits/i);
  assert.match(CLEAN_SYSTEM_PROMPT, /never change a negation/i);

  const prompt = buildCleanPrompt(planCleanBatches(turns(2)).batches[0]);
  assert.match(prompt, /\[0\] Them: /);
  assert.match(prompt, /\[1\] You: /);
});

test('parser accepts mechanical fixes and maps them back to the same turns', () => {
  const input = [
    { id: 1, channel: 'them', text: 'so the deprecation of the vee four pro model', ts: 10 },
    { id: 2, channel: 'you', text: 'right and that means the flash model stays the vision one', ts: 20 },
  ];
  const batch = planCleanBatches(input).batches[0];
  const result = parseCleanBatch(reply([
    '[0] Them: So the deprecation of the V4 Pro model.',
    '[1] You: Right, and that means the Flash model stays the vision one.',
  ]), batch);
  assert.equal(result.failed, false);
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
  const result = parseCleanBatch(reply([
    '[0] Them: They cannot migrate twice a quarter.',
    '[1] You: Let me pull the numbers on that before we commit to anything.',
  ]), batch);
  assert.equal(result.accepted.has(0), false, 'summarised line is rejected');
  assert.equal(result.rejected[0].index, 0);
  assert.match(result.rejected[0].reason, /length/);
  assert.equal(result.accepted.get(1), 'Let me pull the numbers on that before we commit to anything.');
});

test('parser rejects invented padding longer than the spoken turn', () => {
  const input = [{ id: 1, channel: 'them', text: 'ship it friday', ts: 10 }];
  const batch = planCleanBatches(input).batches[0];
  const result = parseCleanBatch('[0] Them: Ship it Friday, and then monitor the deploy closely while telling the whole team about the rollout plan.', batch);
  assert.equal(result.accepted.has(0), false);
  assert.match(result.rejected[0].reason, /length/);
});

test('parser refuses a batch whose markers are not exactly the expected set in order', () => {
  const input = turns(3);
  const batch = planCleanBatches(input).batches[0];

  const unknownMarker = parseCleanBatch(reply([
    '[0] Them: Utterance number 0 with enough words in it.',
    '[7] Them: This marker was never sent.',
  ]), batch);
  assert.equal(unknownMarker.failed, true);
  assert.equal(unknownMarker.reason, 'marker_mismatch');
  assert.equal(unknownMarker.accepted.size, 0);

  const duplicateMarker = parseCleanBatch(reply([
    '[0] Them: Utterance number 0 with enough words in it.',
    '[0] Them: Utterance number 0 with enough words in it.',
    '[2] Them: Utterance number 2 with enough words in it.',
  ]), batch);
  assert.equal(duplicateMarker.failed, true, 'a duplicated marker is not trusted');

  const reordered = parseCleanBatch(reply([
    '[1] You: Utterance number 1 with enough words in it.',
    '[0] Them: Utterance number 0 with enough words in it.',
    '[2] Them: Utterance number 2 with enough words in it.',
  ]), batch);
  assert.equal(reordered.failed, true, 'out-of-order markers are not trusted');

  const droppedLine = parseCleanBatch(reply([
    '[0] Them: Utterance number 0 with enough words in it.',
    '[2] Them: Utterance number 2 with enough words in it.',
  ]), batch);
  assert.equal(droppedLine.failed, true, 'a dropped line fails the batch rather than shifting text');
});

test('parser keeps raw wording for an empty line inside an otherwise valid batch', () => {
  const input = turns(2);
  const batch = planCleanBatches(input).batches[0];
  const result = parseCleanBatch(reply([
    '[0] Them: Utterance number 0 with enough words in it.',
    '[1] You:',
  ]), batch);
  assert.equal(result.failed, false);
  assert.deepEqual(result.rejected.map((item) => item.index), [1]);
  assert.deepEqual(result.missing, [1]);
});

test('parser joins a hard-wrapped continuation instead of discarding the turn', () => {
  const input = [{ id: 1, channel: 'them', text: 'we should ship the migration on friday and then watch the error rate', ts: 10 }];
  const batch = planCleanBatches(input).batches[0];
  const result = parseCleanBatch(reply([
    '[0] Them: We should ship the migration on Friday',
    'and then watch the error rate.',
  ]), batch);
  assert.equal(result.failed, false);
  assert.equal(result.accepted.get(0), 'We should ship the migration on Friday and then watch the error rate.');
});

test('parser rejects a flipped negation even though the length looks legitimate', () => {
  const raw = 'we will not ship the migration before the audit finishes';
  const input = [{ id: 1, channel: 'them', text: raw, ts: 10 }];
  const batch = planCleanBatches(input).batches[0];
  const result = parseCleanBatch('[0] Them: We will ship the migration before the audit finishes.', batch);
  assert.equal(result.accepted.has(0), false);
  assert.match(result.rejected[0].reason, /negation/);
});

test('parser rejects a changed number', () => {
  const input = [{ id: 1, channel: 'them', text: 'the invoice came to 4200 dollars last quarter', ts: 10 }];
  const batch = planCleanBatches(input).batches[0];
  const result = parseCleanBatch('[0] Them: The invoice came to 4500 dollars last quarter.', batch);
  assert.equal(result.accepted.has(0), false);
  assert.match(result.rejected[0].reason, /number/);
});

test('parser lets a legitimate filler collapse through', () => {
  const input = [{ id: 1, channel: 'them', text: 'that that that that that that', ts: 10 }];
  const batch = planCleanBatches(input).batches[0];
  const result = parseCleanBatch('[0] Them: That.', batch);
  assert.equal(result.accepted.get(0), 'That.');
});

test('parser never rewrites a turn too short to check', () => {
  const input = [{ id: 1, channel: 'you', text: 'yeah sure', ts: 10 }];
  assert.ok(input[0].text.length < MIN_SHORT_TURN_CHARS);
  const batch = planCleanBatches(input).batches[0];
  const result = parseCleanBatch('[0] You: Yes, sure.', batch);
  assert.equal(result.accepted.has(0), false);
  assert.match(result.rejected[0].reason, /short turn/);
});

test('parser tolerates code fences and an echoed speaker label the model added', () => {
  const input = [{ id: 1, channel: 'you', text: 'can you hear me now', ts: 10 }];
  const batch = planCleanBatches(input).batches[0];
  const result = parseCleanBatch(['```', '[0] You: Can you hear me now?', '```'].join('\n'), batch);
  assert.equal(result.accepted.get(0), 'Can you hear me now?');
});

test('cleanedTextsFrom returns text only, aligned to the saved turns', () => {
  const input = turns(4);
  const accepted = new Map([
    [1, 'Utterance number one, with enough words in it.'],
    [3, 'Utterance number three, with enough words in it.'],
  ]);
  const cleaned = cleanedTextsFrom(input, accepted);
  assert.equal(cleaned.length, input.length);
  assert.equal(cleaned[0], input[0].text, 'uncleaned turn keeps raw text');
  assert.equal(cleaned[1], 'Utterance number one, with enough words in it.');
  assert.equal(cleaned[2], input[2].text);
  assert.equal(cleaned[3], 'Utterance number three, with enough words in it.');
});

test('fidelity helpers describe what they reject', () => {
  assert.equal(fidelityIssue('we cannot ship on 12 friday', 'We cannot ship on 12 Friday.'), null);
  assert.match(fidelityIssue('we cannot ship', 'We can ship'), /negation/);
  assert.match(fidelityIssue('12 items arrived', 'Twelve items arrived'), /number/);
  assert.equal(collapseRepeatedTokens('the the the point is'), 'the point is');
});
