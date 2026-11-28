const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');

function functionSource(source, name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = source.slice(start + 1).match(/\n[ \t]*(?:async\s+)?function\s+/);
  const end = next ? start + 1 + next.index : source.length;
  return source.slice(start, end);
}

function reviewHarness(provider = 'OpenAI') {
  const review = {
    token: 'review-token-1',
    createdAt: Date.now(),
    sessionGeneration: 4,
    slideContext: 'Slide 1: Exact reviewed text',
    transcriptSnapshot: [{ id: 1, channel: 'them', text: 'Exact transcript', ts: 1 }],
    transcriptContext: 'Them: Exact transcript',
    provider: 'OpenAI',
  };
  const calls = [];
  const context = {
    state: { busy: false },
    responseDiagnosticPromise: null,
    activeHistoryJob: null,
    sessionGeneration: 4,
    pendingSlideReview: review,
    store: { getSettings: () => ({ provider: 'openai' }) },
    chooseInitialProvider: () => ({ llm: { ready: true, label: provider } }),
    createResponseRoute: () => ({}),
    slideTracker: { list: () => ({ slides: [{ sequence: 1, ocrStatus: 'ready', text: 'Exact reviewed text' }] }) },
    runFeature: (...args) => { calls.push(args); return Promise.resolve(); },
  };
  vm.createContext(context);
  vm.runInContext(functionSource(main, 'confirmSlideReview'), context);
  return { context, review, calls };
}

test('a rejected slide review confirmation retains the exact main-process snapshot and token', () => {
  const { context, review } = reviewHarness('Different provider');

  assert.throws(() => context.confirmSlideReview(review.token), /selected provider changed/i);
  assert.equal(context.pendingSlideReview, review);
  assert.equal(context.pendingSlideReview.slideContext, 'Slide 1: Exact reviewed text');
  assert.equal(context.pendingSlideReview.transcriptSnapshot[0].text, 'Exact transcript');
});

test('a busy meeting-history task retains the slide review token instead of reporting a send', () => {
  const { context, review } = reviewHarness();
  context.activeHistoryJob = {};

  assert.throws(() => context.confirmSlideReview(review.token), /meeting-history task/i);
  assert.equal(context.pendingSlideReview, review);
});

test('a successful slide review confirmation consumes the token and sends the retained snapshot', () => {
  const { context, review, calls } = reviewHarness();

  const result = context.confirmSlideReview(review.token);
  assert.equal(result.started, true);
  assert.equal(result.slideCount, 1);
  assert.equal(result.provider, 'OpenAI');
  assert.equal(context.pendingSlideReview, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'slide-review');
  assert.equal(calls[0][2].slideContext, review.slideContext);
  assert.equal(calls[0][2].slideReviewTranscript, review.transcriptSnapshot);
});

test('canceling a slide review consumes only its matching token', () => {
  const { context, review } = reviewHarness();
  vm.runInContext(functionSource(main, 'cancelSlideReview'), context);

  assert.equal(context.cancelSlideReview('stale-token').canceled, false);
  assert.equal(context.pendingSlideReview, review);
  assert.equal(context.cancelSlideReview(review.token).canceled, true);
  assert.equal(context.pendingSlideReview, null);
});

test('closing the review dialog cancels its token and leaves Confirm disabled', async () => {
  const marker = "document.getElementById('slide-review-dialog').addEventListener('close', () => {";
  const start = renderer.indexOf(marker);
  assert.notEqual(start, -1);
  const end = renderer.indexOf('\n  });', start);
  assert.notEqual(end, -1);
  const source = renderer.slice(start, end + '\n  });'.length);
  const payloads = [];
  const button = { dataset: { reviewToken: 'review-token-1' }, disabled: false };
  let closeHandler;
  const context = {
    $: () => button,
    document: { getElementById: () => ({ addEventListener: (_name, handler) => { closeHandler = handler; } }) },
    volyxLens: { slideTrackingReview: (payload) => { payloads.push({ ...payload }); return Promise.resolve({ canceled: true }); } },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  closeHandler();

  assert.deepEqual(payloads, [{ cancelled: true, token: 'review-token-1' }]);
  assert.equal(button.dataset.reviewToken, undefined);
  assert.equal(button.disabled, true);
});

function slideRuntimeHarness() {
  const slides = [{ sequence: 1, ocrStatus: 'ready', text: 'Kept preview text', preview: 'data:image/jpeg;base64,AA==' }];
  const sent = [];
  const handlers = {};
  const writes = [];
  const timers = [];
  let failDisarm = true;
  const context = {
    state: { capturing: false },
    store: {
      getSettings: () => ({ transcription: { slideTracking: true } }),
      setSettings: (patch) => {
        writes.push({ ...patch.transcription });
        if (failDisarm && patch.transcription.slideTracking === false) throw new Error('mock disk full');
      },
    },
    slideTracker: {
      list: () => ({ slides, total: slides.length }),
      clear: () => { slides.length = 0; return { cleared: 0 }; },
    },
    slideTrackingTimer: { id: 'old-timer' },
    slideTrackingGeneration: 7,
    slideTrackingPaused: false,
    slideOcrJobs: new Map(),
    clearInterval: (timer) => { context.clearedTimer = timer; },
    setInterval: (callback, delay) => { const timer = { id: 'new-timer', callback, delay }; timers.push(timer); return timer; },
    sampleSlideFrame: () => {},
    send: (channel, payload) => sent.push({ channel, payload }),
    console: { log: () => {} },
    handleTrusted: (channel, handler) => { handlers[channel] = handler; },
  };
  vm.createContext(context);
  for (const name of ['slideTrackingState', 'publishSlideTrackingState', 'pauseSlideTracking', 'startSlideTracking', 'stopSlideTracking']) {
    vm.runInContext(functionSource(main, name), context);
  }
  const handlerStart = main.indexOf("handleTrusted('slide-tracking:set-enabled'");
  assert.notEqual(handlerStart, -1);
  const handlerEnd = main.indexOf('\n});', handlerStart);
  vm.runInContext(main.slice(handlerStart, handlerEnd + '\n});'.length), context);
  context.stopSlideTracking = () => {
    context.slideTrackingTimer = null;
    context.slideTrackingPaused = false;
    slides.length = 0;
  };
  return { context, slides, sent, handlers, writes, timers, allowDisarm: () => { failDisarm = false; } };
}

test('capture failure publishes paused off runtime state even when disarm persistence fails', () => {
  const { context, slides, sent } = slideRuntimeHarness();

  context.pauseSlideTracking();

  const state = sent.find((entry) => entry.channel === 'slide-tracking:state').payload;
  assert.equal(state.enabled, false);
  assert.equal(state.active, false);
  assert.equal(state.paused, true);
  assert.equal(context.slideTrackingTimer, null);
  assert.equal(context.slideTrackingGeneration, 8);
  assert.equal(slides.length, 1);
  assert.equal(slides[0].text, 'Kept preview text');
});

test('explicit ON retries a paused sampler even when the stored preference is still true', () => {
  const { context, slides, handlers, writes, timers } = slideRuntimeHarness();
  context.pauseSlideTracking();
  const state = handlers['slide-tracking:set-enabled'](null, true);

  assert.equal(state.enabled, true);
  assert.equal(state.active, true);
  assert.equal(state.paused, false);
  assert.notEqual(context.slideTrackingTimer, null);
  assert.equal(timers.length, 1);
  assert.equal(writes[writes.length - 1].slideTracking, true);
  assert.equal(slides.length, 1, 'retrying a paused sampler must not erase preserved previews');
});

test('an unrelated Settings save does not restart a paused slide sampler', () => {
  const starts = [];
  const stops = [];
  const settings = { transcription: { slideTracking: true, language: '' } };
  const patch = { transcription: { language: 'en' } };
  const updated = { transcription: { slideTracking: true, language: 'en' } };
  const context = {
    store: { getSettings: () => settings },
    patch,
    updated,
    previous: { transcription: { slideTracking: true, language: '' } },
    wasSlideTrackingRuntimeEnabled: false,
    slideTrackingTimer: null,
    slideTrackingPaused: true,
    slideTrackingState: () => ({ enabled: false, active: false, paused: true }),
    startSlideTracking: () => starts.push('start'),
    stopSlideTracking: () => stops.push('stop'),
  };
  const start = main.indexOf('  const wasSlideTrackingEnabled = previous.transcription');
  const end = main.indexOf('  // The notification toggle is also the switch that arms background checking.', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  vm.createContext(context);
  vm.runInContext(main.slice(start, end), context);

  assert.deepEqual(starts, [], 'a paused sampler restarts only after an explicit slide-enabled edit');
  assert.deepEqual(stops, []);
});

function mergeSettings(target, patch = {}) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)
      && target[key] && typeof target[key] === 'object') mergeSettings(target[key], value);
    else target[key] = JSON.parse(JSON.stringify(value));
  }
  return target;
}

function slideSettingsHarness() {
  const slides = [
    { sequence: 1, preview: 'data:image/jpeg;base64,AA==', text: 'First retained slide', ocrStatus: 'ready' },
    { sequence: 2, preview: 'data:image/jpeg;base64,AQ==', text: 'Second retained slide', ocrStatus: 'ready' },
  ];
  const settings = {
    appearance: { theme: 'sage' },
    notifications: { updates: true },
    transcription: {
      slideTracking: true,
      historyEnabled: false,
      meetingMemory: false,
      customVocabulary: '',
      diarization: {},
    },
  };
  const handlers = {};
  const starts = [];
  const samples = [];
  const context = {
    state: { capturing: false },
    store: {
      getSettings: () => settings,
      setSettings: (patch) => { mergeSettings(settings, patch); },
      updateSettingsAndApiKeys: (patch) => { mergeSettings(settings, patch); return settings; },
      getPublicSettings: () => settings,
    },
    slideTracker: {
      list: () => ({ slides, total: slides.length }),
      clear: () => { slides.length = 0; return { cleared: 0 }; },
    },
    slideTrackingTimer: { id: 'old-timer' },
    slideTrackingGeneration: 3,
    slideTrackingPaused: false,
    slideTrackingInFlight: false,
    slideOcrJobs: new Map(),
    pendingSlideReview: null,
    clearInterval: (timer) => { context.clearedTimer = timer; },
    setInterval: (callback, delay) => {
      const timer = { id: 'new-timer', callback, delay };
      starts.push(timer);
      return timer;
    },
    sampleSlideFrame: () => { samples.push('sample'); },
    cancelSlideOcr: () => false,
    send: () => {},
    console: { log: () => {} },
    offlineWhisperStatus: () => ({ available: true }),
    localSpeechRuntimeStatus: () => ({ available: true }),
    transcriptionSettingsChanged: () => false,
    resetSttErrorState: () => {},
    updateScheduler: { sync: () => {} },
    speechModelsWithStatus: () => [],
    speechDiarizerStatus: () => ({}),
    handleTrusted: (channel, handler) => { handlers[channel] = handler; },
  };
  vm.createContext(context);
  for (const name of ['slideTrackingState', 'publishSlideTrackingState', 'clearSlideTrackingData', 'startSlideTracking', 'stopSlideTracking', 'pauseSlideTracking']) {
    vm.runInContext(functionSource(main, name), context);
  }
  const handlerStart = main.indexOf("handleTrusted('settings:set'");
  const handlerEnd = main.indexOf('\n});', handlerStart);
  assert.notEqual(handlerStart, -1);
  assert.notEqual(handlerEnd, -1);
  vm.runInContext(main.slice(handlerStart, handlerEnd + '\n});'.length), context);
  return { context, slides, settings, handlers, starts, samples };
}

test('an unrelated full Settings mirror preserves previews after a successful pause', () => {
  const { context, slides, settings, handlers, starts, samples } = slideSettingsHarness();
  const previews = slides.map(({ sequence, preview, text }) => ({ sequence, preview, text }));

  context.pauseSlideTracking();
  const paused = context.slideTrackingState();
  const mirror = JSON.parse(JSON.stringify(settings));
  mirror.appearance.theme = 'indigo';
  handlers['settings:set'](null, mirror);
  const after = context.slideTrackingState();

  assert.equal(settings.transcription.slideTracking, false, 'pause must successfully persist the disarm');
  assert.equal(paused.paused, true);
  assert.equal(after.paused, true, 'an unrelated mirror save must not convert a pause into a destructive stop');
  assert.equal(after.enabled, false);
  assert.equal(after.active, false);
  assert.equal(context.slideTrackingTimer, null);
  assert.deepEqual(slides.map(({ sequence, preview, text }) => ({ sequence, preview, text })), previews);
  assert.deepEqual(starts, []);
  assert.deepEqual(samples, []);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function slideOcrHarness() {
  const slides = new Map([
    [1, { sequence: 1, preview: 'preview-1', text: '', ocrStatus: 'pending' }],
    [2, { sequence: 2, preview: 'preview-2', text: '', ocrStatus: 'pending' }],
  ]);
  const settings = { transcription: { slideTracking: true } };
  const ocrCalls = [];
  const cancellations = [];
  const statuses = [];
  const context = {
    MAX_PENDING_SLIDE_OCR_JOBS: 2,
    store: {
      getSettings: () => settings,
      setSettings: (patch) => { mergeSettings(settings, patch); },
    },
    slideTracker: {
      list: () => ({ slides: [...slides.values()], total: slides.size }),
      attachText: (sequence, text, status) => {
        const slide = slides.get(sequence);
        if (!slide) return false;
        slide.text = text;
        slide.ocrStatus = status;
        return true;
      },
      clear: () => { slides.clear(); return { cleared: 0 }; },
    },
    slideOcrJobs: new Map(),
    slideOcrJobSequence: 0,
    slideTrackingGeneration: 1,
    slideTrackingPaused: false,
    slideTrackingTimer: { id: 'old-timer' },
    clearInterval: () => {},
    setInterval: () => ({ id: 'new-timer' }),
    sampleSlideFrame: () => {},
    localOcr: {
      recognize: (preview, { jobId }) => {
        const work = deferred();
        ocrCalls.push({ preview, jobId, ...work });
        return work.promise;
      },
      cancelQueued: () => false,
      cancel: (jobId) => { cancellations.push(jobId); return true; },
    },
    publishSlideTrackingState: () => {},
    send: (_channel, payload) => { statuses.push(payload.message); },
    console: { log: () => {} },
  };
  vm.createContext(context);
  for (const name of ['cancelSlideOcr', 'cancelOldestQueuedSlideOcr', 'processSlideOcr', 'pauseSlideTracking', 'startSlideTracking']) {
    vm.runInContext(functionSource(main, name), context);
  }
  return {
    context,
    slides,
    settings,
    ocrCalls,
    cancellations,
    statuses,
    addSlide: (sequence) => slides.set(sequence, { sequence, preview: `preview-${sequence}`, text: '', ocrStatus: 'pending' }),
  };
}

test('pausing slide tracking cancels pending OCR and fails the preserved slides', async () => {
  const { context, slides, ocrCalls, cancellations } = slideOcrHarness();
  const first = context.processSlideOcr(1, 'preview-1', 1);
  const second = context.processSlideOcr(2, 'preview-2', 1);
  assert.equal(context.slideOcrJobs.size, 2);

  context.pauseSlideTracking();

  assert.deepEqual(cancellations, ['slide-ocr-1', 'slide-ocr-2']);
  assert.equal(context.slideOcrJobs.size, 0, 'pause must release every invalidated queue slot immediately');
  assert.equal(slides.get(1).ocrStatus, 'failed');
  assert.equal(slides.get(2).ocrStatus, 'failed');
  assert.equal(slides.get(1).text, '');
  assert.equal(slides.get(2).text, '');
  assert.equal(slides.get(1).preview, 'preview-1');
  assert.equal(slides.get(2).preview, 'preview-2');

  ocrCalls[0].resolve({ status: 'cancelled' });
  ocrCalls[1].resolve({ status: 'cancelled' });
  await Promise.all([first, second]);
  assert.equal(context.slideOcrJobs.size, 0);
});

test('a stale-generation OCR completion removes its own queue entry', async () => {
  const { context, slides, ocrCalls } = slideOcrHarness();
  const job = context.processSlideOcr(1, 'preview-1', 1);
  context.slideTrackingGeneration += 1;

  ocrCalls[0].resolve({ status: 'ready', text: 'Stale text' });
  await job;

  assert.equal(context.slideOcrJobs.size, 0, 'a stale completion must not retain a bounded queue slot');
  assert.equal(slides.get(1).ocrStatus, 'pending', 'a stale completion must not update the current tracker');
  assert.equal(slides.get(1).text, '');
});


function rendererSlideHarness({ dirty = false } = {}) {
  const elements = new Map();
  const element = () => ({
    classList: { toggle() {}, contains: () => false },
    setAttribute(name, value) { this[name] = value; },
    checked: false,
    disabled: false,
    textContent: '',
    replaceChildren() {},
    appendChild() {},
  });
  for (const selector of [
    '#slide-tracking-indicator', '#slide-tracking-toolbar-indicator', '#slide-tracking-toggle',
    '#stt-slide-tracking', '#settings-scrim', '#slide-tracking-panel', '#slide-tracking-count',
    '#slide-tracking-clear', '#slide-tracking-review', '#slide-tracking-note', '#slide-tracking-list',
  ]) elements.set(selector, element());
  const context = {
    $: (selector) => elements.get(selector),
    document: { createElement: () => ({ className: '', textContent: '', appendChild() {} }) },
    slideTracking: { enabled: false, active: false, paused: false, slides: [], total: 0 },
    slideSettingDirty: dirty,
    settings: { transcription: { slideTracking: !dirty } },
  };
  if (dirty) {
    elements.get('#stt-slide-tracking').checked = true;
    elements.get('#stt-slide-tracking')['aria-checked'] = 'true';
  }
  vm.createContext(context);
  vm.runInContext(functionSource(renderer, 'renderSlideTracking'), context);
  return { context, elements };
}

test('a stored slide preference without a sampler is off and can be explicitly retried', () => {
  const { context, handlers, timers } = slideRuntimeHarness();
  context.slideTrackingTimer = null;
  context.slideTrackingPaused = false;
  context.publishSlideTrackingState();
  const before = context.slideTrackingState();
  const state = handlers['slide-tracking:set-enabled'](null, true);

  assert.equal(before.enabled, false, 'the pre-retry snapshot must not claim an absent sampler is on');
  assert.equal(before.active, false);
  assert.equal(state.enabled, true);
  assert.equal(state.active, true);
  assert.equal(timers.length, 1);
  assert.notEqual(context.slideTrackingTimer, null);
});

test('renderer never claims slide tracking is on when the sampler is inactive', () => {
  const { context, elements } = rendererSlideHarness();
  context.renderSlideTracking({ enabled: true, active: false, slides: [], total: 0 });

  assert.equal(elements.get('#slide-tracking-toggle')['aria-checked'], 'false');
  assert.equal(context.slideTracking.enabled, false);
  assert.equal(context.slideTracking.paused, true);
  assert.equal(elements.get('#stt-slide-tracking').checked, false);
  assert.equal(elements.get('#stt-slide-tracking')['aria-checked'], 'false');
  assert.equal(context.settings.transcription.slideTracking, false);
});

test('clean slide state synchronizes the Settings mirror and accessible switch state', () => {
  const { context, elements } = rendererSlideHarness();
  context.renderSlideTracking({ enabled: true, active: true, paused: false, slides: [], total: 0 });

  assert.equal(elements.get('#slide-tracking-toggle')['aria-checked'], 'true');
  assert.equal(elements.get('#stt-slide-tracking').checked, true);
  assert.equal(elements.get('#stt-slide-tracking')['aria-checked'], 'true');
  assert.equal(context.settings.transcription.slideTracking, true);
});

test('a slide state broadcast preserves a dirty Settings choice and its accessible state', () => {
  const { context, elements } = rendererSlideHarness({ dirty: true });
  context.renderSlideTracking({ enabled: false, active: false, paused: true, slides: [], total: 0 });

  assert.equal(elements.get('#slide-tracking-toggle')['aria-checked'], 'false');
  assert.equal(elements.get('#stt-slide-tracking').checked, true);
  assert.equal(elements.get('#stt-slide-tracking')['aria-checked'], 'true');
  assert.equal(context.settings.transcription.slideTracking, false);
  assert.equal(context.slideSettingDirty, true);
});

test('an expired slide review closes and disables Confirm until a fresh review', async () => {
  const start = renderer.indexOf("  $('#slide-review-confirm').addEventListener('click', async () => {");
  const end = renderer.indexOf('\n  });', start);
  const source = renderer.slice(start, end + '\n  });'.length);
  const payloads = [];
  let closes = 0;
  const button = { dataset: { reviewToken: 'expired-token' }, disabled: false };
  button.addEventListener = (_name, handler) => { button.handler = handler; };
  const context = {
    $: () => button,
    document: { getElementById: () => ({ close: () => { closes += 1; } }) },
    volyxLens: { slideTrackingReview: async (payload) => {
      payloads.push({ ...payload });
      throw new Error('Slide review expired. Prepare the review again before sending.');
    } },
    showStatus: () => {},
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  await button.handler();

  assert.equal(closes, 1);
  assert.equal(button.dataset.reviewToken, undefined);
  assert.equal(button.disabled, true);
  assert.deepEqual(payloads, [
    { confirmed: true, token: 'expired-token' },
    { cancelled: true, token: 'expired-token' },
  ]);
});

test('the renderer keeps Confirm tokenized after failure and retries the identical payload', async () => {
  const start = renderer.indexOf("  $('#slide-review-confirm').addEventListener('click', async () => {");
  assert.notEqual(start, -1);
  const endMarker = '\n  });';
  const end = renderer.indexOf(endMarker, start);
  assert.notEqual(end, -1);
  const handlerSource = renderer.slice(start, end + endMarker.length);
  const payloads = [];
  const statuses = [];
  let closes = 0;
  let attempts = 0;
  const button = { dataset: { reviewToken: 'review-token-1' }, disabled: false };
  const dialog = { close: () => { closes += 1; } };
  const context = {
    $: (selector) => {
      assert.equal(selector, '#slide-review-confirm');
      return button;
    },
    document: { getElementById: (id) => {
      assert.equal(id, 'slide-review-dialog');
      return dialog;
    } },
    volyxLens: { slideTrackingReview: async (payload) => {
      payloads.push({ ...payload });
      attempts += 1;
      if (attempts === 1) throw new Error('mock send failure');
      return { started: true, slideCount: 1, provider: 'OpenAI' };
    } },
    showStatus: (message) => statuses.push(message),
  };
  // Attach the shipped registration to a minimal DOM shim, then execute the
  // real async callback rather than a copied implementation.
  vm.createContext(context);
  button.addEventListener = (_name, callback) => { button.handler = callback; };
  vm.runInContext(handlerSource, context);
  await button.handler();

  assert.match(statuses[0], /mock send failure/);
  assert.equal(button.dataset.reviewToken, 'review-token-1');
  assert.equal(button.disabled, false);
  assert.equal(closes, 0);

  await button.handler();
  assert.deepEqual(payloads, [
    { confirmed: true, token: 'review-token-1' },
    { confirmed: true, token: 'review-token-1' },
  ]);
  assert.equal(closes, 1);
  assert.equal(button.dataset.reviewToken, undefined);
  assert.equal(button.disabled, true, 'a closed, tokenless Confirm button must stay disabled');
});
