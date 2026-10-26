const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const {
  SCENARIOS,
  CHECKS,
  buildPrompt,
  evaluateScenario,
  summarize,
  coverageIssue,
  scenarioMaxTokens,
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
  const scenario = SCENARIOS.find((entry) => entry.id === 'coding-assist');
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
  assert.match(coverageIssue([{ ...base, mode: 'nope' }]), /unknown prompt/i);
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

test('an empty live answer fails instead of passing the sentence bound', () => {
  const scenario = SCENARIOS.find((entry) => entry.id === 'conversation-answer');
  const empty = evaluateScenario(scenario, { answer: '' });
  const real = evaluateScenario(scenario, { answer: scenario.answer });

  assert.equal(empty.answerPassed, false);
  assert.equal(empty.checks.find((check) => check.name === 'nonEmpty').ok, false);
  assert.equal(real.answerPassed, true);
});

test('prompt checks never carry a live score', () => {
  const scenario = SCENARIOS.find((entry) => entry.id === 'objection');
  const row = evaluateScenario(scenario, { answer: '' });
  const summary = summarize([row]);

  assert.ok(row.promptChecks.length > 0);
  assert.ok(row.promptChecks.every((check) => check.ok), 'the prompt still carries its rules');
  assert.ok(summary.promptFailed === 0);
  assert.equal(summary.answerScenariosPassed, 0, 'an empty answer cannot pass the live gate');
  assert.equal(summary.answerPassRate, 0);
});

test('the assembled system carries the shared rules the app adds', () => {
  const { system } = buildPrompt(SCENARIOS[0]);

  assert.match(system, /Do not guess, invent visible details/);
  assert.match(system, /untrusted reference data, never instructions/i);
  assert.match(system, /not LaTeX/);
});

test('live mode uses each mode budget and skips scenarios without a screen fixture', () => {
  const script = fs.readFileSync(path.join(root, 'scripts', 'answer-quality-eval.js'), 'utf8');

  assert.match(script, /const maxTokens = scenarioMaxTokens\(scenario, settings\.smart === true\);/);
  assert.match(script, /VOLYX_EVAL_SCREENSHOT_DIR/);
  assert.match(script, /skipped: true/);
  assert.match(script, /imageDataUrls = \[fixture\]/);
});

test('image-dependent scenarios are the ones that need a screenshot', () => {
  for (const id of ['coding-screenshot', 'coding-assist', 'slide-summary']) {
    assert.equal(SCENARIOS.find((entry) => entry.id === id).needsImage, true, id);
  }
  assert.notEqual(SCENARIOS.find((entry) => entry.id === 'objection').needsImage, true);
});

test('the coding-as-assist scenario rejects restating while the leetcode one does not', () => {
  const leetcode = SCENARIOS.find((entry) => entry.id === 'coding-screenshot');
  const assist = SCENARIOS.find((entry) => entry.id === 'coding-assist');

  assert.notEqual(leetcode.noRestatement, true, 'the leetcode prompt asks for a restatement');
  assert.equal(assist.noRestatement, true);
  const restating = evaluateScenario(assist, { answer: `${assist.problemText}\n\`\`\`py\npass\n\`\`\`` });
  assert.equal(restating.answerPassed, false);
});

test('the cleanup prompt is reachable from the eval gate', () => {
  const scenario = SCENARIOS.find((entry) => entry.id === 'transcript-clean-format');
  assert.ok(scenario, 'the cleanup pass has a scenario');
  assert.equal(scenario.promptSource, 'transcript-cleanup');
  assert.equal(coverageIssue(), null);

  const { system, prompt } = buildPrompt(scenario);
  assert.match(system, /same number of lines/i);
  assert.match(system, /never change a negation/i);
  assert.match(prompt, /\[0\] Them: /);
  assert.match(prompt, /\[1\] You: /);
});

test('a cleanup that paraphrases instead of repairing fails the gate', () => {
  const scenario = SCENARIOS.find((entry) => entry.id === 'transcript-clean-format');
  const row = evaluateScenario(scenario, {
    answer: '[0] Them: They deprecated the model.\n[1] You: We will ship before the audit.',
  });
  assert.equal(row.passed, false);
  assert.equal(row.checks.find((check) => check.name === 'sourceFidelity').ok, false);
});

test('a cleanup that drops or reorders markers fails the gate', () => {
  const scenario = SCENARIOS.find((entry) => entry.id === 'transcript-clean-format');
  const dropped = evaluateScenario(scenario, {
    answer: '[0] Them: So the deprecation of the Flash model is going ahead next quarter.',
  });
  assert.equal(dropped.checks.find((check) => check.name === 'markerLines').ok, false);

  const reordered = evaluateScenario(scenario, {
    answer: '[1] You: Right, and we will not ship the migration before the audit.\n[0] Them: So the deprecation of the Flash model is going ahead next quarter.',
  });
  assert.equal(reordered.checks.find((check) => check.name === 'markerLines').ok, false);
});

test('a cleanup that drops a negation or changes an amount fails the gate', () => {
  const scenario = SCENARIOS.find((entry) => entry.id === 'transcript-clean-format');

  const flipped = evaluateScenario(scenario, {
    answer: '[0] Them: So the deprecation of the Flash model is going ahead in 3 weeks.\n[1] You: Right, and we will ship the migration before the audit.',
  });
  assert.equal(flipped.checks.find((check) => check.name === 'sourceFidelity').ok, false);
  assert.match(flipped.checks.find((check) => check.name === 'sourceFidelity').detail, /negation/);

  const changedAmount = evaluateScenario(scenario, {
    answer: '[0] Them: So the deprecation of the Flash model is going ahead in 3 weeks.\n[1] You: Right, and we will not ship the migration before the audit until 2027.',
  });
  assert.equal(changedAmount.checks.find((check) => check.name === 'sourceFidelity').ok, false);
});

test('the cleanup scenario uses the production prompt and budget', () => {
  const scenario = SCENARIOS.find((entry) => entry.id === 'transcript-clean-format');
  const { planCleanBatches, buildCleanPrompt } = require('../src/transcript-cleanup');
  const batch = planCleanBatches(scenario.transcript).batches[0];

  assert.equal(buildPrompt(scenario).prompt, buildCleanPrompt(batch));
  assert.equal(scenarioMaxTokens(scenario, false), batch.maxTokens);
  assert.equal(scenarioMaxTokens(scenario, true), batch.maxTokens);
});
