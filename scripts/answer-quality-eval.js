'use strict';

// Answer-quality eval. Two modes:
//   default        deterministic, offline: assembles each scenario's prompt and
//                  scores a recorded answer against explicit rubrics. Runs in CI
//                  and fails when a prompt stops carrying a rule it needs.
//   --live         sends the same prompts to the configured provider and scores
//                  the real answers. Costs money, so it never runs in CI.
//
// The deterministic half is the regression gate; the live half is for comparing
// prompt or temperature changes with numbers instead of impressions.

const { MODES } = require('../src/prompts');
const { CLEAN_SYSTEM_PROMPT, planCleanBatches, buildCleanPrompt, fidelityIssue } = require('../src/transcript-cleanup');
const { tokenRecall } = require('../src/transcript-dedupe');
const { buildPreviousMeetingsBlock, PREVIOUS_MEETINGS_NOTE } = require('../src/meeting-memory');
const {
  SOURCE_UNCERTAINTY_RULE,
  UNTRUSTED_INPUT_RULE,
  PLAIN_TEXT_OUTPUT_RULE,
} = require('../src/response-context');

const MIN_LIVE_PASS_RATE = 0.75;

// ----- answer rubrics -------------------------------------------------------

function stripCode(text) {
  return String(text || '').replace(/```[\s\S]*?```/g, ' ');
}

function sentenceCount(text) {
  const stripped = stripCode(text).replace(/\s+/g, ' ').trim();
  if (!stripped) return 0;
  return stripped.split(/(?<=[.!?])\s+/).filter((part) => part.trim().length > 0).length;
}

function firstWords(text, count) {
  return String(text || '').toLowerCase().match(/[a-z0-9']+/g)?.slice(0, count) || [];
}

const CHECKS = {
  // A cleanup answer must keep every turn's marker, once each, in order. A
  // missing or duplicated marker means the text no longer lines up with the
  // recording, which is worse than an unpolished sentence.
  markerLines(answer, scenario) {
    const expected = Array.isArray(scenario.transcript) ? scenario.transcript.length : 0;
    const lines = String(answer || '').split('\n').map((line) => line.trim()).filter(Boolean);
    const markers = lines
      .map((line) => (line.match(/^\[(\d+)\]/) || [])[1])
      .filter((value) => value !== undefined)
      .map(Number);
    const ok = expected > 0
      && lines.length === expected
      && markers.length === expected
      && markers.every((marker, index) => marker === index);
    return { ok, detail: `${markers.length}/${expected} marker(s) in order` };
  },

  // A repair may fix wording but must not drop the content: every source turn
  // keeps nearly all of its words, and every number survives.
  sourceFidelity(answer, scenario) {
    const turns = Array.isArray(scenario.transcript) ? scenario.transcript : [];
    if (!turns.length) return { ok: true, detail: 'no source turns' };
    const lines = String(answer || '').split('\n').map((line) => line.trim()).filter(Boolean);
    for (let index = 0; index < turns.length; index += 1) {
      const raw = String(turns[index] && turns[index].text || '');
      const text = (lines[index] || '').replace(/^\[\d+\]\s*(?:(?:you|them)\s*:\s*)?/i, '');
      const recall = tokenRecall(text, raw);
      if (recall < 0.9) return { ok: false, detail: `turn ${index} kept ${Math.round(recall * 100)}% of its words` };
      // Word recall cannot see a flipped negation or a changed amount, so the
      // same guard the app applies before storing a cleaned turn runs here.
      const issue = fidelityIssue(raw, text);
      if (issue) return { ok: false, detail: `turn ${index}: ${issue}` };
    }
    return { ok: true, detail: `${turns.length} turn(s) preserved` };
  },

  codeFence(answer) {
    const blocks = String(answer || '').match(/```[\s\S]+?```/g) || [];
    return { ok: blocks.length > 0, detail: `${blocks.length} fenced block(s)` };
  },

  noCodeFence(answer) {
    const ok = !/```/.test(String(answer || ''));
    return { ok, detail: ok ? 'no code block' : 'unexpected code block' };
  },

  // A coding answer must not open by reading the problem back to the user.
  noRestatement(answer, scenario) {
    const lead = firstWords(scenario.problemText || '', 8);
    if (!lead.length) return { ok: true, detail: 'no problem text' };
    const opening = firstWords(answer, 60);
    let cursor = 0;
    let matched = 0;
    for (const word of opening) {
      if (word === lead[cursor]) {
        matched += 1;
        cursor += 1;
        if (cursor === lead.length) break;
      }
    }
    const ok = matched < Math.min(lead.length, 6);
    return { ok, detail: `${matched}/${lead.length} problem words echoed` };
  },

  maxSentences(answer, scenario) {
    const count = sentenceCount(answer);
    return { ok: count <= scenario.maxSentences, detail: `${count} sentence(s), limit ${scenario.maxSentences}` };
  },

  matches(answer, scenario) {
    const ok = scenario.mustMatch.every((pattern) => pattern.test(String(answer || '')));
    return { ok, detail: `${scenario.mustMatch.length} required pattern(s)` };
  },

  avoids(answer, scenario) {
    const ok = scenario.mustNotMatch.every((pattern) => !pattern.test(String(answer || '')));
    return { ok, detail: `${scenario.mustNotMatch.length} forbidden pattern(s)` };
  },

  promptCarries(prompt, scenario) {
    const ok = scenario.promptMatch.every((pattern) => pattern.test(prompt));
    return { ok, detail: `${scenario.promptMatch.length} prompt rule(s)` };
  },

  promptAvoids(prompt, scenario) {
    const ok = (scenario.promptAvoid || []).every((pattern) => !pattern.test(prompt));
    return { ok, detail: `${(scenario.promptAvoid || []).length} forbidden prompt pattern(s)` };
  },

  budget(scenario) {
    const def = promptDefinition(scenario);
    let budgets = def && def.maxTokens;
    if (def && def.resolve) {
      const resolved = def.resolve(scenario).maxTokens;
      budgets = Number.isFinite(resolved) ? { fast: resolved, smart: resolved } : null;
    }
    if (!budgets) return { ok: false, detail: `${scenario.promptSource || scenario.mode} has no budget` };
    const ok = scenario.minBudget.fast <= budgets.fast && scenario.minBudget.smart <= budgets.smart;
    return { ok, detail: `${budgets.fast}/${budgets.smart}, need ${scenario.minBudget.fast}/${scenario.minBudget.smart}` };
  },
};

// ----- scenarios ------------------------------------------------------------

const PROBLEM_TEXT = 'Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.';

const SCENARIOS = [
  {
    id: 'coding-screenshot',
    mode: 'leetcode',
    needsImage: true,
    problemText: PROBLEM_TEXT,
    answer: [
      'Hash map of seen values to indices; check the complement before inserting.',
      '```python',
      'def two_sum(nums, target):',
      '    seen = {}',
      '    for i, n in enumerate(nums):',
      '        if target - n in seen:',
      '            return [seen[target - n], i]',
      '        seen[n] = i',
      '```',
      'Time O(n), space O(n).',
    ].join('\n'),
    codeFence: true,
    promptMatch: [/expert competitive programmer/i, /time and space complexity/i],
    minBudget: { fast: 1600, smart: 2600 },
  },
  {
    id: 'coding-assist',
    mode: 'assist',
    needsImage: true,
    problemText: PROBLEM_TEXT,
    answer: 'Hash map from value to index, check the complement before inserting.\n```python\ndef two_sum(nums, target):\n    seen = {}\n    for i, n in enumerate(nums):\n        if target - n in seen:\n            return [seen[target - n], i]\n        seen[n] = i\n```\nTime O(n), space O(n).',
    codeFence: true,
    noRestatement: true,
    maxSentences: 4,
    promptMatch: [/never repeat, restate, or transcribe/i],
  },
  {
    id: 'error-dialog',
    mode: 'assist',
    userText: 'What is wrong with this screen?',
    transcript: [{ channel: 'them', text: 'Can you check this error?' }],
    answer: 'The certificate expired on the 12th, so the client rejects the handshake. Renew it on the server and restart the proxy, then reload the page to confirm the lock icon returns.',
    noCodeFence: true,
    maxSentences: 3,
    mustMatch: [/certificate/i, /renew/i],
    promptMatch: [/other technical problem/i, /likely cause/i, /specific fix/i],
    promptAvoid: [/coding or technical problem/i],
  },
  {
    id: 'status-update',
    mode: 'assist',
    userText: 'Where are we on the migration?',
    transcript: [{ channel: 'them', text: 'Quick status on the migration?' }],
    answer: 'The schema changes are applied and verified on staging. Next is the backfill, which starts tonight. Nothing is blocked, but the cutover window still needs sign-off.',
    maxSentences: 3,
    mustMatch: [/next/i, /blocked/i],
    promptMatch: [/status request gets what changed/i],
  },
  {
    id: 'pricing-question',
    mode: 'assist',
    userText: 'What should I say about price?',
    transcript: [{ channel: 'them', text: 'What does this cost for a team of ten?' }],
    answer: 'For ten seats it lands at about 4,800 a year on the annual plan. If that is tight we can start with five and add seats as the team grows.',
    maxSentences: 3,
    mustMatch: [/\d/],
    promptMatch: [/commitment, price, or negotiation/i],
  },
  {
    id: 'objection',
    mode: 'say',
    transcript: [
      { channel: 'them', text: 'Honestly, this sounds more expensive than what we pay now.' },
    ],
    answer: 'I understand the price jump is the hard part. We include onboarding and support, which is usually where the other quote grows, so the all-in number is closer than it looks.',
    maxSentences: 3,
    mustMatch: [/\b(I|we)\b/],
    promptMatch: [/objection gets an acknowledgement/i, /write the words to say/i],
  },
  {
    id: 'slide-summary',
    mode: 'assist-screen',
    needsImage: true,
    userText: 'Explain this slide.',
    answer: 'The slide claims onboarding drops to four minutes after the guided setup. The implication is that the manual steps were the bottleneck, not the import itself.',
    maxSentences: 3,
    mustMatch: [/(key|implies|implication)/i],
    promptMatch: [/document, slide, or chart/i],
  },
  {
    id: 'meeting-memory',
    mode: 'ask',
    userText: 'What did we agree about the migration last time?',
    transcript: [{ channel: 'them', text: 'Remind me where we landed on the migration.' }],
    previousMeetings: [
      { endedAt: Date.UTC(2026, 9, 20), notes: { summary: 'Agreed to move the migration into its own milestone before feature work resumes.' } },
    ],
    answer: 'Last time you agreed to move the migration into its own milestone before resuming feature work.',
    mustMatch: [/migration/i],
    promptMatch: [/Previous meeting summaries/i, /move the migration into its own milestone/i, /untrusted reference data/i],
  },
  {
    id: 'conversation-answer',
    mode: 'assist-conversation',
    transcript: [{ channel: 'them', text: 'How would you keep the rollout safe?' }],
    answer: 'I would ship it behind a flag to one team first, watch the error rate for a day, then widen it. If anything moves, we flip the flag back before it reaches customers.',
    maxSentences: 3,
    promptMatch: [/gets a direct answer/i, /three sentences at most/i],
  },
  {
    // Not a user-facing mode: the cleanup pass writes back into a saved record,
    // so its prompt is gated here rather than being left to unit assertions.
    id: 'transcript-clean-format',
    mode: 'clean',
    promptSource: 'transcript-cleanup',
    transcript: [
      { channel: 'them', text: 'so the deprecation of the flash model is going ahead in 3 weeks' },
      { channel: 'you', text: 'right and we will not ship the migration before the audit' },
    ],
    answer: [
      '[0] Them: So the deprecation of the Flash model is going ahead in 3 weeks.',
      '[1] You: Right, and we will not ship the migration before the audit.',
    ].join('\n'),
    markerLines: true,
    sourceFidelity: true,
    promptMatch: [/same number of lines/i, /same order/i, /not\b[^.]*summar/i, /never change a negation/i],
    // The cleanup budget is computed per batch, not fixed per tier, so this
    // asserts a real floor rather than pinning today's number.
    minBudget: { fast: 200, smart: 200 },
  },
];

// ----- evaluation -----------------------------------------------------------

// Prompts that are not user-facing modes still need coverage: the cleanup pass
// writes back into a saved record, so it belongs in the same gate.
const PROMPT_SOURCES = {
  'transcript-cleanup': {
    system: CLEAN_SYSTEM_PROMPT,
    // Built by the same planner and prompt builder the app uses, so a change to
    // either one shows up here instead of leaving the gate green.
    resolve(scenario) {
      const plan = planCleanBatches(scenario.transcript || []);
      const batch = plan.batches[0];
      if (!batch) return { prompt: '', maxTokens: null };
      return { prompt: buildCleanPrompt(batch), maxTokens: batch.maxTokens };
    },
  },
};

function promptDefinition(scenario) {
  if (scenario.promptSource) return PROMPT_SOURCES[scenario.promptSource] || null;
  return MODES[scenario.mode] || null;
}

function buildPrompt(scenario) {
  const def = promptDefinition(scenario);
  if (!def) throw new Error(`Unknown prompt for scenario ${scenario.id}: ${scenario.promptSource || scenario.mode}`);
  let prompt = def.resolve
    ? def.resolve(scenario).prompt
    : def.build({
      transcript: scenario.transcript || [],
      userText: scenario.userText || '',
      slideContext: scenario.slideContext || '',
    });
  if (scenario.previousMeetings) {
    const block = buildPreviousMeetingsBlock(scenario.previousMeetings);
    if (block.count) prompt += `\n\n${PREVIOUS_MEETINGS_NOTE}\n\n${block.text}`;
  }
  const system = [def.system || '', SOURCE_UNCERTAINTY_RULE, UNTRUSTED_INPUT_RULE, PLAIN_TEXT_OUTPUT_RULE]
    .filter(Boolean)
    .join('\n\n');
  return { prompt, system };
}

function scenarioMaxTokens(scenario, smart = false) {
  const def = promptDefinition(scenario);
  if (!def) return undefined;
  if (def.resolve) {
    const resolved = def.resolve(scenario).maxTokens;
    return Number.isFinite(resolved) ? resolved : undefined;
  }
  const budgets = def.maxTokens;
  return budgets ? (smart ? budgets.smart : budgets.fast) : undefined;
}

function evaluateScenario(scenario, { answer: overrideAnswer } = {}) {
  const { prompt, system } = buildPrompt(scenario);
  const fullPrompt = `${system}\n\n${prompt}`;
  const text = overrideAnswer == null ? scenario.answer : overrideAnswer;
  const checks = [];

  const answerCheck = (name, result) => checks.push({ name, kind: 'answer', ...result });
  const promptCheck = (name, result) => checks.push({ name, kind: 'prompt', ...result });

  if (overrideAnswer != null) answerCheck('nonEmpty', { ok: String(text).trim().length > 0, detail: String(text).trim() ? 'answer present' : 'empty answer' });
  if (scenario.codeFence) answerCheck('codeFence', CHECKS.codeFence(text));
  if (scenario.noCodeFence) answerCheck('noCodeFence', CHECKS.noCodeFence(text));
  if (scenario.noRestatement) answerCheck('noRestatement', CHECKS.noRestatement(text, scenario));
  if (scenario.maxSentences) answerCheck('maxSentences', CHECKS.maxSentences(text, scenario));
  if (scenario.mustMatch) answerCheck('matches', CHECKS.matches(text, scenario));
  if (scenario.mustNotMatch) answerCheck('avoids', CHECKS.avoids(text, scenario));
  if (scenario.markerLines) answerCheck('markerLines', CHECKS.markerLines(text, scenario));
  if (scenario.sourceFidelity) answerCheck('sourceFidelity', CHECKS.sourceFidelity(text, scenario));
  if (scenario.promptMatch) promptCheck('promptCarries', CHECKS.promptCarries(fullPrompt, scenario));
  if (scenario.promptAvoid) promptCheck('promptAvoids', CHECKS.promptAvoids(fullPrompt, scenario));
  if (scenario.minBudget) promptCheck('budget', CHECKS.budget(scenario));

  const answerChecks = checks.filter((check) => check.kind === 'answer');
  const promptChecks = checks.filter((check) => check.kind === 'prompt');
  return {
    id: scenario.id,
    mode: scenario.mode,
    checks,
    answerChecks,
    promptChecks,
    answerPassed: answerChecks.length > 0 && answerChecks.every((check) => check.ok),
    passed: checks.every((check) => check.ok),
  };
}

function summarize(rows) {
  const active = rows.filter((row) => (row.checks || []).length > 0);
  const checks = active.flatMap((row) => row.checks);
  const promptFailed = checks.filter((check) => check.kind === 'prompt' && !check.ok).length;
  const answerFailed = checks.filter((check) => check.kind === 'answer' && !check.ok).length;
  const answered = active.filter((row) => (row.answerChecks || []).length > 0);
  const scenariosPassed = answered.filter((row) => row.answerPassed).length;
  return {
    scenarios: active.length,
    checks: checks.length,
    passed: checks.filter((check) => check.ok).length,
    failed: checks.filter((check) => !check.ok).length,
    promptFailed,
    answerFailed,
    answerScenarios: answered.length,
    answerScenariosPassed: scenariosPassed,
    answerPassRate: answered.length ? scenariosPassed / answered.length : 0,
    passRate: checks.length ? checks.filter((check) => check.ok).length / checks.length : 0,
    failedIds: active.filter((row) => !row.passed).map((row) => row.id),
    skippedIds: rows.filter((row) => row.skipped).map((row) => row.id),
  };
}

function coverageIssue(scenarios = SCENARIOS) {
  const ids = new Set();
  const modes = new Set();
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) return `duplicate scenario id: ${scenario.id}`;
    ids.add(scenario.id);
    if (!promptDefinition(scenario)) return `unknown prompt: ${scenario.promptSource || scenario.mode}`;
    modes.add(scenario.mode);
  }
  if (!modes.has('leetcode')) return 'missing a coding scenario';
  if (!modes.has('say')) return 'missing a spoken-reply scenario';
  if (!modes.has('ask')) return 'missing a typed-question scenario';
  return null;
}

// ----- CLI ------------------------------------------------------------------

function formatRows(rows) {
  const lines = [];
  for (const row of rows) {
    lines.push(`${row.passed ? 'PASS' : 'FAIL'}  ${row.id} (${row.mode})`);
    for (const check of row.checks) {
      if (!check.ok) lines.push(`      ${check.name}: ${check.detail}`);
    }
  }
  return lines.join('\n');
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];

function readImageFixture(dir, id) {
  if (!dir) return null;
  for (const extension of IMAGE_EXTENSIONS) {
    const candidate = require('node:path').join(dir, `${id}.${extension}`);
    try {
      const data = require('node:fs').readFileSync(candidate);
      const mime = extension === 'jpg' ? 'jpeg' : extension;
      return `data:image/${mime};base64,${data.toString('base64')}`;
    } catch {
      // try the next extension
    }
  }
  return null;
}

async function runLive({ provider, apiKey, model, smart }) {
  const { createLLM } = require('../src/llm');
  const { getDefaultSettings } = require('../src/provider-config');
  const settings = getDefaultSettings();
  settings.provider = provider;
  settings.apiKeys[provider] = apiKey;
  settings.models[provider] = { fast: model, smart: model };
  settings.smart = smart === true;
  const llm = createLLM(settings);
  const fixtureDir = process.env.VOLYX_EVAL_SCREENSHOT_DIR || '';
  const rows = [];

  for (const scenario of SCENARIOS) {
    let imageDataUrls = [];
    if (scenario.needsImage) {
      const fixture = readImageFixture(fixtureDir, scenario.id);
      if (!fixture) {
        rows.push({ id: scenario.id, mode: scenario.mode, checks: [], skipped: true });
        continue;
      }
      imageDataUrls = [fixture];
    }

    const { prompt, system } = buildPrompt(scenario);
    const maxTokens = scenarioMaxTokens(scenario, settings.smart === true);
    let answer = null;
    try {
      answer = await llm.stream({ system, turns: [{ role: 'user', text: prompt }], imageDataUrls, maxTokens, onToken() {} });
    } catch (error) {
      rows.push({
        id: scenario.id,
        mode: scenario.mode,
        checks: [{ name: 'request', kind: 'answer', ok: false, detail: error.message }],
        answerChecks: [{ name: 'request', kind: 'answer', ok: false, detail: error.message }],
        promptChecks: [],
        answerPassed: false,
        passed: false,
      });
      continue;
    }
    const row = evaluateScenario(scenario, { answer });
    row.answer = answer;
    rows.push(row);
    console.log(`\n--- ${scenario.id} (${maxTokens || 'default'} tokens) ---\n${String(answer).slice(0, 600)}`);
  }
  return rows;
}

async function main(argv = process.argv.slice(2)) {
  const live = argv.includes('--live');
  if (coverageIssue()) throw new Error(coverageIssue());

  let rows;
  if (live) {
    const provider = process.env.VOLYX_EVAL_PROVIDER || 'openai';
    const apiKey = process.env.VOLYX_EVAL_KEY || '';
    const model = process.env.VOLYX_EVAL_MODEL || '';
    if (!apiKey || !model) throw new Error('Live mode needs VOLYX_EVAL_KEY and VOLYX_EVAL_MODEL.');
    rows = await runLive({ provider, apiKey, model, smart: argv.includes('--smart') });
  } else {
    rows = SCENARIOS.map((scenario) => evaluateScenario(scenario));
  }

  console.log(formatRows(rows));
  const summary = summarize(rows);
  if (summary.skippedIds.length) {
    console.log(`Skipped (no screenshot fixture in VOLYX_EVAL_SCREENSHOT_DIR): ${summary.skippedIds.join(', ')}`);
  }
  console.log(`\n${summary.passed}/${summary.checks} checks passed across ${summary.scenarios} scenarios (${(summary.passRate * 100).toFixed(0)}%).`);
  if (summary.failedIds.length) console.log(`Failing scenarios: ${summary.failedIds.join(', ')}`);

  if (live) {
    const answered = summary.answerScenarios;
    console.log(`${summary.answerScenariosPassed}/${answered} live answers passed every rubric (${(summary.answerPassRate * 100).toFixed(0)}%).`);
    if (!answered || summary.answerPassRate < MIN_LIVE_PASS_RATE) process.exitCode = 1;
  } else if (summary.promptFailed > 0 || summary.answerFailed > 0) {
    process.exitCode = 1;
  }
  return summary;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[answer-eval] ${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  SCENARIOS,
  CHECKS,
  PROMPT_SOURCES,
  promptDefinition,
  scenarioMaxTokens,
  buildPrompt,
  evaluateScenario,
  summarize,
  coverageIssue,
  sentenceCount,
  MIN_LIVE_PASS_RATE,
};
