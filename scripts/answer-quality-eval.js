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
const { buildPreviousMeetingsBlock, PREVIOUS_MEETINGS_NOTE } = require('../src/meeting-memory');

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
    const budgets = MODES[scenario.mode] && MODES[scenario.mode].maxTokens;
    if (!budgets) return { ok: false, detail: `${scenario.mode} has no budget` };
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
    noRestatement: true,
    promptMatch: [/expert competitive programmer/i, /time and space complexity/i],
    minBudget: { fast: 1600, smart: 2600 },
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
];

// ----- evaluation -----------------------------------------------------------

function buildPrompt(scenario) {
  const def = MODES[scenario.mode];
  if (!def) throw new Error(`Unknown mode in scenario ${scenario.id}: ${scenario.mode}`);
  let prompt = def.build({
    transcript: scenario.transcript || [],
    userText: scenario.userText || '',
    slideContext: scenario.slideContext || '',
  });
  if (scenario.previousMeetings) {
    const block = buildPreviousMeetingsBlock(scenario.previousMeetings);
    if (block.count) prompt += `\n\n${PREVIOUS_MEETINGS_NOTE}\n\n${block.text}`;
  }
  return { prompt, system: def.system || '' };
}

function evaluateScenario(scenario, { answer } = {}) {
  const { prompt, system } = buildPrompt(scenario);
  const fullPrompt = `${system}\n\n${prompt}`;
  const text = answer == null ? scenario.answer : answer;
  const checks = [];

  if (scenario.codeFence) checks.push({ name: 'codeFence', ...CHECKS.codeFence(text) });
  if (scenario.noCodeFence) checks.push({ name: 'noCodeFence', ...CHECKS.noCodeFence(text) });
  if (scenario.noRestatement) checks.push({ name: 'noRestatement', ...CHECKS.noRestatement(text, scenario) });
  if (scenario.maxSentences) checks.push({ name: 'maxSentences', ...CHECKS.maxSentences(text, scenario) });
  if (scenario.mustMatch) checks.push({ name: 'matches', ...CHECKS.matches(text, scenario) });
  if (scenario.mustNotMatch) checks.push({ name: 'avoids', ...CHECKS.avoids(text, scenario) });
  if (scenario.promptMatch) checks.push({ name: 'promptCarries', ...CHECKS.promptCarries(fullPrompt, scenario) });
  if (scenario.promptAvoid) checks.push({ name: 'promptAvoids', ...CHECKS.promptAvoids(fullPrompt, scenario) });
  if (scenario.minBudget) checks.push({ name: 'budget', ...CHECKS.budget(scenario) });

  return {
    id: scenario.id,
    mode: scenario.mode,
    checks,
    passed: checks.every((check) => check.ok),
  };
}

function summarize(rows) {
  const total = rows.reduce((sum, row) => sum + row.checks.length, 0);
  const passed = rows.reduce((sum, row) => sum + row.checks.filter((check) => check.ok).length, 0);
  const failedRows = rows.filter((row) => !row.passed);
  return {
    scenarios: rows.length,
    checks: total,
    passed,
    failed: total - passed,
    passRate: total ? passed / total : 0,
    failedIds: failedRows.map((row) => row.id),
  };
}

function coverageIssue(scenarios = SCENARIOS) {
  const ids = new Set();
  const modes = new Set();
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) return `duplicate scenario id: ${scenario.id}`;
    ids.add(scenario.id);
    if (!MODES[scenario.mode]) return `unknown mode: ${scenario.mode}`;
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

async function runLive({ provider, apiKey, model, smart }) {
  const { createLLM } = require('../src/llm');
  const { getDefaultSettings } = require('../src/provider-config');
  const settings = getDefaultSettings();
  settings.provider = provider;
  settings.apiKeys[provider] = apiKey;
  settings.models[provider] = { fast: model, smart: model };
  settings.smart = smart === true;
  const llm = createLLM(settings);
  const rows = [];
  for (const scenario of SCENARIOS) {
    const { prompt, system } = buildPrompt(scenario);
    let answer = '';
    try {
      answer = await llm.stream({ system, turns: [{ role: 'user', text: prompt }], onToken() {} });
    } catch (error) {
      rows.push({ id: scenario.id, mode: scenario.mode, checks: [{ name: 'request', ok: false, detail: error.message }], passed: false });
      continue;
    }
    const row = evaluateScenario(scenario, { answer });
    row.answer = answer;
    rows.push(row);
    console.log(`\n--- ${scenario.id} ---\n${String(answer).slice(0, 600)}`);
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
  console.log(`\n${summary.passed}/${summary.checks} checks passed across ${summary.scenarios} scenarios (${(summary.passRate * 100).toFixed(0)}%).`);
  if (summary.failedIds.length) console.log(`Failing scenarios: ${summary.failedIds.join(', ')}`);

  if (live) {
    if (summary.passRate < MIN_LIVE_PASS_RATE) process.exitCode = 1;
  } else if (summary.failed > 0) {
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
  buildPrompt,
  evaluateScenario,
  summarize,
  coverageIssue,
  sentenceCount,
  MIN_LIVE_PASS_RATE,
};
