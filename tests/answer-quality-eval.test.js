const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SCENARIOS,
  CHECKS,
  buildPrompt,
  evaluateScenario,
  summarize,
  coverageIssue,
  MIN_LIVE_PASS_RATE,
} = require('../scripts/answer-quality-eval');
const { MODES } = require('../src/prompts');

test('every shipped scenario passes its rubric', () => {
  const rows = SCENARIOS.map((scenario) => evaluateScenario(scenario));
  const summary = summarize(rows);

  assert.equal(coverageIssue(), null);
  assert.deepEqual(summary.failedIds, []);
  assert.equal(summary.failed, 0);
  assert.ok(summary.checks >= 20, 'the suite should hold a meaningful number of checks');
});

test('a coding answer with no code block fails the fence check', () => {
  const scenario = SCENARIOS.find((entry) => entry.id === 'coding-screenshot');
  const row = evaluateScenario(scenario, { answer: 'Use a hash map and iterate once. Time O(n), space O(n).' });

  assert.equal(row.passed, false);
  assert.equal(row.checks.find((check) => check.name === 'codeFence').ok, false);
});

test('an answer that reads the problem back fails the restatement check', () => {
  const scenario = SCENARIOS.find((entry) => entry.id === 'coding-screenshot');
  const row = evaluateScenario(scenario, {
    answer: 'Given an array of integers nums and an integer target, return indices of the two numbers.\n```py\npass\n```',
  });

  assert.equal(row.checks.find((check) => check.name === 'noRestatement').ok, false);
});

test('a rambling reply fails the sentence bound', () => {
  const scenario = SCENARIOS.find((entry) => entry.id === 'objection');
  const row = evaluateScenario(scenario, {
    answer: 'I understand the price concern. Let me walk through the details. We include onboarding. We include support. We include training. The all-in number is usually lower.',
  });

  assert.equal(row.checks.find((check) => check.name === 'maxSentences').ok, false);
});

test('a prompt that loses its shape rules fails, which is the regression this eval exists for', () => {
  const scenario = SCENARIOS.find((entry) => entry.id === 'error-dialog');
  const original = MODES.assist.system;
  try {
    MODES.assist.system = 'You are Volyx Lens. Be helpful and concise.';
    const row = evaluateScenario(scenario);
    assert.equal(row.passed, false);
    assert.equal(row.checks.find((check) => check.name === 'promptCarries').ok, false);
  } finally {
    MODES.assist.system = original;
  }
});

test('meeting memory is only in the prompt when summaries are supplied', () => {
  const scenario = SCENARIOS.find((entry) => entry.id === 'meeting-memory');
  const withMemory = buildPrompt(scenario).prompt;
  const withoutMemory = buildPrompt({ ...scenario, previousMeetings: [] }).prompt;

  assert.match(withMemory, /move the migration into its own milestone/i);
  assert.doesNotMatch(withoutMemory, /move the migration into its own milestone/i);
});

test('coverage reports duplicate ids and unknown modes instead of passing quietly', () => {
  const base = SCENARIOS[0];
  assert.match(coverageIssue([base, base]), /duplicate/i);
  assert.match(coverageIssue([{ ...base, mode: 'nope' }]), /unknown mode/i);
  assert.equal(coverageIssue([]), 'missing a coding scenario');
});

test('summarize counts checks, not just scenarios', () => {
  const rows = [
    { id: 'a', checks: [{ ok: true }, { ok: false }], passed: false },
    { id: 'b', checks: [{ ok: true }], passed: true },
  ];
  const summary = summarize(rows);

  assert.equal(summary.scenarios, 2);
  assert.equal(summary.checks, 3);
  assert.equal(summary.passed, 2);
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.failedIds, ['a']);
  assert.ok(MIN_LIVE_PASS_RATE > 0 && MIN_LIVE_PASS_RATE <= 1);
});

test('the sentence counter ignores fenced code', () => {
  const withCode = 'One line. ```js\nconst a = 1;\n``` Two lines.';
  assert.equal(CHECKS.maxSentences(withCode, { maxSentences: 2 }).ok, true);
  assert.equal(CHECKS.codeFence(withCode).ok, true);
});
