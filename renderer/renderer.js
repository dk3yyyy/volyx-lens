/* Volyx Lens renderer — UI state, mic capture, IPC, streaming render. */
(function () {
  const { icon } = window.ICONS;
  const volyxLens = window.volyxLens; // exposed by preload
  const $ = (s) => document.querySelector(s);

  // ---- paint icons -------------------------------------------------------
  $('#logo-btn').innerHTML = icon('logo', { size: 18 });
  $('.tb-hide .chev').innerHTML = icon('chevron-down', { size: 14 });
  $('#new-session-btn .new-icon').innerHTML = icon('refresh-cw', { size: 14 });
  $('#kill-btn').innerHTML = icon('power', { size: 15 });
  document.querySelector('.act[data-mode="assist"] .ic').innerHTML = icon('sparkles', { size: 16 });
  document.querySelector('.act[data-mode="say"] .ic').innerHTML = icon('wand-sparkles', { size: 16 });
  document.querySelector('.act[data-mode="followup"] .ic').innerHTML = icon('message-circle', { size: 16 });
  document.querySelector('.act[data-mode="recap"] .ic').innerHTML = icon('refresh-cw', { size: 16 });
  $('#task-context-toggle .ic').innerHTML = icon('camera', { size: 16 });
  $('#smart-toggle .ic').innerHTML = icon('zap', { size: 14 });
  $('#more-btn').innerHTML = icon('more-horizontal', { size: 18 });
  $('#send-btn').innerHTML = icon('play', { size: 15 });

  // ---- state -------------------------------------------------------------
  let settings = null;
  let personalContext = null;
  let taskContext = { count: 0, maxCaptures: null, maxTotalBytes: 96 * 1024 * 1024, totalBytes: 0, pinnedCount: 0, lastCapturedAt: null, revision: 0, lastEviction: null, nearDuplicatesRejected: 0, fingerprintFailures: 0, ocrBytes: 0, ocrReadyCount: 0, ocrPendingCount: 0, ocrUnavailableCount: 0, ocrFailedCount: 0, ocrEvictedCount: 0, overlapLinkedCount: 0 };
  const taskContextPage = { offset: 0, limit: 50, total: 0, captures: [], revision: -1 };
  let taskContextListRequest = 0;
  let providerView = 'openai';
  let providerTestActive = false;
  let shortcutStatus = [];
  let busy = false;
  let transcriptTurns = [];
  const partialTranscript = { you: null, them: null };
  let listeningActive = false;
  let diagnosticsTimer = null;
  let activeRequestMode = null;
  let aiEl = null;       // current streaming <div class="ai-text">
  let caretEl = null;

  const messages = $('#messages');
  const AUDIO_SAMPLE_RATE = volyxLens.audioConfig.sampleRate;

  function updateListeningButton(active) {
    const button = $('#stop-btn');
    const label = active ? 'Stop Listening' : 'Start Listening';
    button.classList.toggle('active', active);
    button.querySelector('.listen-icon').innerHTML = icon(active ? 'stop-square' : 'mic', { size: 15 });
    button.querySelector('.listen-label').textContent = label;
    button.title = label;
    button.setAttribute('aria-label', label);
  }
  updateListeningButton(false);

  function formatTaskContextBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (!value) return '0 MB';
    if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function taskContextTime(value) {
    const time = new Date(Number(value));
    return Number.isNaN(time.getTime()) ? 'Unknown time' : time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function taskContextOcrLabel(capture) {
    const characters = Math.max(0, Number(capture.ocrCharacters) || 0);
    if (capture.ocrStatus === 'pending') return 'Text: Processing';
    if (capture.ocrStatus === 'ready') return `Text: ${characters.toLocaleString()} chars${capture.ocrTruncated ? '+' : ''}`;
    if (capture.ocrStatus === 'failed') return 'Text: Failed';
    if (capture.ocrStatus === 'evicted') return 'Text: Evicted';
    return 'Text: Unavailable';
  }

  function taskContextOverlapLabel(capture) {
    if (!capture.overlapPreviousId || !capture.overlapLines) return '';
    const source = Number.isSafeInteger(capture.overlapPreviousSequence) ? `Screen ${capture.overlapPreviousSequence}` : 'an earlier screen';
    if (Number.isSafeInteger(capture.overlapLineStart) && Number.isSafeInteger(capture.overlapLineEnd)) {
      return `Overlap: lines ${capture.overlapLineStart}–${capture.overlapLineEnd} with ${source}`;
    }
    return `Overlap: ~${capture.overlapLines} lines with ${source}`;
  }

  function renderTaskContextEntries() {
    const list = $('#task-context-list');
    list.replaceChildren();
    if (!taskContextPage.captures.length) {
      const empty = document.createElement('div');
      empty.className = 'task-context-empty';
      empty.textContent = taskContextPage.total ? 'No captures on this page.' : 'No saved screens.';
      list.appendChild(empty);
    } else {
      for (const capture of taskContextPage.captures) {
        const row = document.createElement('div');
        row.className = `task-context-entry${capture.pinned ? ' pinned' : ''}`;
        row.dataset.captureId = capture.id;
        row.setAttribute('role', 'listitem');

        const copy = document.createElement('div');
        copy.className = 'task-context-entry-copy';
        const title = document.createElement('strong');
        title.textContent = `Screen ${capture.sequence}${capture.pinned ? ' · Pinned' : ''}`;
        const meta = document.createElement('span');
        const overlapLabel = taskContextOverlapLabel(capture);
        meta.textContent = `${taskContextTime(capture.capturedAt)} · ${formatTaskContextBytes(capture.bytes)} · ${taskContextOcrLabel(capture)}${overlapLabel ? ` · ${overlapLabel}` : ''}`;
        copy.append(title, meta);

        const pin = document.createElement('button');
        pin.type = 'button';
        pin.className = 'task-context-pin';
        pin.dataset.taskContextAction = 'pin';
        pin.setAttribute('aria-pressed', String(capture.pinned === true));
        pin.textContent = capture.pinned ? 'Unpin' : 'Pin';

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'task-context-remove';
        remove.dataset.taskContextAction = 'remove';
        remove.textContent = 'Remove';
        row.append(copy, pin, remove);
        list.appendChild(row);
      }
    }

    const pages = $('#task-context-pages');
    pages.classList.toggle('hidden', taskContextPage.total <= taskContextPage.limit);
    const start = taskContextPage.total ? taskContextPage.offset + 1 : 0;
    const end = Math.min(taskContextPage.total, taskContextPage.offset + taskContextPage.captures.length);
    $('#task-context-page-label').textContent = `${start}–${end} of ${taskContextPage.total}`;
    $('#task-context-prev').disabled = taskContextPage.offset <= 0;
    $('#task-context-next').disabled = taskContextPage.offset + taskContextPage.limit >= taskContextPage.total;
  }

  async function refreshTaskContextList({ offset = taskContextPage.offset, goLast = false } = {}) {
    const requestedOffset = goLast
      ? Math.max(0, Math.floor(Math.max(0, Number(taskContext.count) - 1) / taskContextPage.limit) * taskContextPage.limit)
      : Math.max(0, Number(offset) || 0);
    const requestId = ++taskContextListRequest;
    try {
      const result = await volyxLens.taskContextList(requestedOffset, taskContextPage.limit);
      if (requestId !== taskContextListRequest) return;
      if (result.total > 0 && result.offset >= result.total) {
        await refreshTaskContextList({ offset: Math.floor((result.total - 1) / taskContextPage.limit) * taskContextPage.limit });
        return;
      }
      taskContextPage.offset = result.offset;
      taskContextPage.total = result.total;
      taskContextPage.captures = Array.isArray(result.captures) ? result.captures : [];
      taskContextPage.revision = result.revision;
      renderTaskContextEntries();
    } catch (error) {
      if (requestId === taskContextListRequest) showStatus(error && error.message ? error.message : 'Task Context metadata is unavailable.');
    }
  }

  function renderTaskContext(value) {
    if (value && typeof value === 'object') taskContext = { ...taskContext, ...value };
    const count = Math.max(0, Number(taskContext.count) || 0);
    const pinned = Math.max(0, Number(taskContext.pinnedCount) || 0);
    const similarSkipped = Math.max(0, Number(taskContext.nearDuplicatesRejected) || 0);
    const fingerprintFailures = Math.max(0, Number(taskContext.fingerprintFailures) || 0);
    const overlapLinked = Math.max(0, Number(taskContext.overlapLinkedCount) || 0);
    $('#task-context-count').textContent = `${count} ${count === 1 ? 'screen' : 'screens'} · ${formatTaskContextBytes(taskContext.totalBytes)}${pinned ? ` · ${pinned} pinned` : ''}${overlapLinked ? ` · ${overlapLinked} overlap ${overlapLinked === 1 ? 'link' : 'links'}` : ''}${similarSkipped ? ` · ${similarSkipped} similar skipped` : ''}${fingerprintFailures ? ` · ${fingerprintFailures} visual ${fingerprintFailures === 1 ? 'check' : 'checks'} unavailable` : ''}`;
    $('#task-context-clear').disabled = count === 0;
    $('#task-context-undo').disabled = count === 0;
    $('#task-context-capture').disabled = false;
    const actionCount = $('#task-context-action-count');
    actionCount.textContent = String(count);
    actionCount.classList.toggle('hidden', count === 0);
    const selectionNote = pinned ? ` ${pinned} pinned ${pinned === 1 ? 'screen is' : 'screens are'} protected from ordinary eviction and prioritized for requests.` : '';
    $('#task-context-request-note').textContent = count > 39
      ? `A request attaches at most 39 saved screens using local OCR relevance, pins, and context priority; ${count - 39} remain local.${selectionNote}`
      : `A single request uses a bounded visual window.${selectionNote || ' Volyx Lens discloses if saved screens are omitted.'}`;

    const eviction = $('#task-context-eviction');
    const event = taskContext.lastEviction;
    if (event && Number(event.count) > 0) {
      const labels = (Array.isArray(event.captures) ? event.captures : []).map((capture) => `Screen ${capture.sequence}`);
      const omitted = Math.max(0, Number(event.omitted) || 0);
      eviction.textContent = `Memory limit: ${event.count} oldest unpinned ${event.count === 1 ? 'screen was' : 'screens were'} evicted at ${taskContextTime(event.occurredAt)}${labels.length ? ` (${labels.join(', ')}${omitted ? ` and ${omitted} more` : ''})` : ''}.`;
      eviction.classList.remove('hidden');
    } else {
      eviction.textContent = '';
      eviction.classList.add('hidden');
    }

    if (count === 0) {
      taskContextListRequest += 1;
      Object.assign(taskContextPage, { offset: 0, total: 0, captures: [], revision: Number(taskContext.revision) || 0 });
      renderTaskContextEntries();
    } else if (!$('#task-context-panel').classList.contains('hidden') && taskContextPage.revision !== taskContext.revision) {
      refreshTaskContextList({ goLast: value && value.added === true });
    }
  }

  function setTaskContextOpen(open) {
    $('#task-context-panel').classList.toggle('hidden', !open);
    $('#task-context-toggle').setAttribute('aria-expanded', String(open));
    if (open && taskContextPage.revision !== taskContext.revision) refreshTaskContextList();
  }

  $('#task-context-toggle').addEventListener('click', () => {
    setTaskContextOpen($('#task-context-toggle').getAttribute('aria-expanded') !== 'true');
  });

  async function captureTaskContext() {
    const button = $('#task-context-capture');
    button.disabled = true;
    const original = button.innerHTML;
    button.textContent = 'Capturing…';
    try {
      renderTaskContext(await volyxLens.taskContextCapture());
    } catch (error) {
      showStatus(error && error.message ? error.message : 'Task context could not capture the screen.');
    } finally {
      button.innerHTML = original;
      renderTaskContext(taskContext);
    }
  }

  $('#task-context-capture').addEventListener('click', captureTaskContext);
  $('#task-context-undo').addEventListener('click', async () => {
    try {
      renderTaskContext(await volyxLens.taskContextUndo());
      showStatus('Last Task Context screen removed.');
    } catch (error) { showStatus(error && error.message ? error.message : 'The last Task Context screen could not be removed.'); }
  });
  $('#task-context-clear').addEventListener('click', async () => {
    try {
      renderTaskContext(await volyxLens.taskContextClear());
      showStatus('Task context cleared from memory.');
    } catch (error) { showStatus(error && error.message ? error.message : 'Task context could not be cleared.'); }
  });
  $('#task-context-list').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-task-context-action]');
    const row = button && button.closest('.task-context-entry');
    if (!button || !row) return;
    const id = row.dataset.captureId;
    const capture = taskContextPage.captures.find((entry) => entry.id === id);
    if (!capture) { await refreshTaskContextList(); return; }
    button.disabled = true;
    try {
      if (button.dataset.taskContextAction === 'pin') {
        const result = await volyxLens.taskContextPin(id, !capture.pinned);
        renderTaskContext(result);
        showStatus(result.updated ? `Screen ${capture.sequence} ${capture.pinned ? 'unpinned' : 'pinned'}.` : 'That Task Context screen is no longer available.');
      } else if (button.dataset.taskContextAction === 'remove') {
        const result = await volyxLens.taskContextRemove(id);
        renderTaskContext(result);
        showStatus(result.removed ? `Screen ${capture.sequence} removed from Task Context.` : 'That Task Context screen is no longer available.');
      }
      await refreshTaskContextList();
    } catch (error) {
      showStatus(error && error.message ? error.message : 'Task Context could not be updated.');
      await refreshTaskContextList();
    }
  });
  $('#task-context-prev').addEventListener('click', () => refreshTaskContextList({ offset: Math.max(0, taskContextPage.offset - taskContextPage.limit) }));
  $('#task-context-next').addEventListener('click', () => refreshTaskContextList({ offset: taskContextPage.offset + taskContextPage.limit }));

  function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function normalizeProseMath(s) {
    if (typeof window.volyxLensPlainMath !== 'function') return s;
    return s.split(/(`[^`]*`)/g).map((part) => part.startsWith('`') ? part : window.volyxLensPlainMath(part)).join('');
  }

  // minimal, safe markdown: fenced code, bullets, inline code, bold, paragraphs
  function renderMarkdown(text) {
    const lines = text.split('\n');
    let html = '', inCode = false, inList = false, buf = [];
    const flushP = () => { if (buf.length) { html += '<p>' + inline(buf.join(' ')) + '</p>'; buf = []; } };
    const inline = (s) => esc(normalizeProseMath(s))
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    for (const raw of lines) {
      const line = raw;
      if (/^```/.test(line.trim())) {
        if (!inCode) { flushP(); if (inList) { html += '</ul>'; inList = false; } html += '<pre><code>'; inCode = true; }
        else { html += '</code></pre>'; inCode = false; }
        continue;
      }
      if (inCode) { html += esc(line) + '\n'; continue; }
      if (/^\s*[-*]\s+/.test(line)) { flushP(); if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>'; continue; }
      if (line.trim() === '') { flushP(); if (inList) { html += '</ul>'; inList = false; } continue; }
      buf.push(line.trim());
    }
    flushP(); if (inList) html += '</ul>'; if (inCode) html += '</code></pre>';
    return html;
  }

  function clearMessages() { messages.innerHTML = ''; aiEl = null; caretEl = null; }

  function addUserBubble(text) {
    const b = document.createElement('div');
    b.className = 'user-bubble';
    b.textContent = text;
    messages.appendChild(b);
  }

  function contextUsagePrefix(badge) {
    const labels = [];
    if (badge.dataset.contextSources) labels.push(`Personal context selected: ${badge.dataset.contextSources}`);
    const taskCount = Math.max(0, Number(badge.dataset.taskContextCount) || 0);
    const taskTotal = Math.max(taskCount, Number(badge.dataset.taskContextTotalCount) || 0);
    if (taskCount) labels.push(taskTotal > taskCount ? `Task context: ${taskCount} of ${taskTotal} saved screens attached` : `Task context: ${taskCount} saved ${taskCount === 1 ? 'screen' : 'screens'} attached`);
    return labels.length ? `${labels.join(' · ')} · ` : '';
  }

  function addContextUsage(sources, taskContextCount, taskContextTotalCount, responseProvider) {
    const badge = document.createElement('div');
    badge.className = 'context-usage';
    badge.id = 'response-provider-usage';
    badge.dataset.contextSources = Array.isArray(sources) ? sources.join(' + ') : '';
    badge.dataset.taskContextCount = String(Math.max(0, Number(taskContextCount) || 0));
    badge.dataset.taskContextTotalCount = String(Math.max(0, Number(taskContextTotalCount) || 0));
    badge.textContent = `${contextUsagePrefix(badge)}Response provider: ${responseProvider || settings.provider}`;
    messages.appendChild(badge);
  }

  function updateResponseProvider(label, fallback) {
    const badge = $('#response-provider-usage');
    if (!badge) return;
    badge.textContent = `${contextUsagePrefix(badge)}${fallback ? 'Fallback provider' : 'Response provider'}: ${label}`;
  }

  function startAi(small) {
    aiEl = document.createElement('div');
    aiEl.className = 'ai-text' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    aiEl.appendChild(caretEl);
    messages.appendChild(aiEl);
  }

  function appendToken(t) {
    if (!aiEl) startAi(false);
    aiEl.dataset.raw += t;
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = t;
    aiEl.insertBefore(span, caretEl);
  }

  function finalizeAi(announcement = 'Response ready.') {
    if (!aiEl) return;
    const raw = aiEl.dataset.raw || '';
    aiEl.innerHTML = renderMarkdown(raw);
    aiEl = null; caretEl = null;
    $('#assistant-status').textContent = announcement;
  }

  const ACTION_LABELS = Object.freeze({ assist: 'Assist', say: 'What should I say?', followup: 'Follow-up questions', recap: 'Recap' });
  function isAssistMode(mode) { return ['assist', 'assist-screen', 'assist-conversation'].includes(mode); }
  function setBusy(value, mode = activeRequestMode) {
    busy = value;
    if (value && mode) activeRequestMode = mode;
    const processingButtonMode = isAssistMode(activeRequestMode) ? 'assist' : activeRequestMode;
    $('#send-btn').classList.toggle('busy', value);
    $('#cancel-response').classList.toggle('hidden', !value);
    document.querySelectorAll('.act[data-mode]').forEach((button) => {
      const buttonMode = button.dataset.mode;
      const processing = value && buttonMode === processingButtonMode;
      const label = button.querySelector('.assist-label, .action-label');
      button.disabled = value;
      button.classList.toggle('processing', processing);
      button.setAttribute('aria-busy', String(processing));
      if (label) label.textContent = processing ? 'Working' : ACTION_LABELS[buttonMode];
      button.title = processing ? `${ACTION_LABELS[buttonMode]} is processing…` : ACTION_LABELS[buttonMode];
    });
    $('#assist-context').disabled = value;
    if (!value) activeRequestMode = null;
  }

  // ---- actions -----------------------------------------------------------
  $('#cancel-response').addEventListener('click', () => volyxLens.cancelResponse());

  function selectedAssistMode() {
    const context = $('#assist-context').value;
    return context === 'screen' ? 'assist-screen' : (context === 'conversation' ? 'assist-conversation' : 'assist');
  }
  function runMode(mode, text, options = {}) {
    if (busy) return;
    if (mode === 'assist') mode = selectedAssistMode();
    setBusy(true, mode);
    volyxLens.ask({ mode, text: text || '', confirmedLongRecap: options.confirmedLongRecap === true });
  }

  document.querySelectorAll('.act[data-mode]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.mode;
      if (mode === 'recap') {
        try {
          const plan = await volyxLens.recapPlan();
          if (plan.requiresChunking) {
            const sampling = plan.sampled ? ' The session is extremely long, so 12 evenly spaced parts will be sampled.' : '';
            const approved = window.confirm(`This long-meeting recap will make ${plan.requestCount} model requests (${plan.parts} part summaries plus one final recap). Provider charges may apply.${sampling} Continue?`);
            if (!approved) return;
            runMode(mode, '', { confirmedLongRecap: true });
            return;
          }
        } catch (error) {
          showStatus(error && error.message ? error.message : 'Could not estimate recap cost.');
          return;
        }
      }
      runMode(mode, '');
    });
  });

  const input = $('#input');
  const placeholder = $('#placeholder');
  const composer = $('#composer');

  function syncPlaceholder() {
    placeholder.classList.toggle('hidden', input.value.length > 0 || document.activeElement === input);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }
  input.addEventListener('input', syncPlaceholder);
  input.addEventListener('focus', () => { composer.classList.add('focused'); placeholder.classList.add('hidden'); });
  input.addEventListener('blur', () => { composer.classList.remove('focused'); syncPlaceholder(); });
  $('#input-area').addEventListener('click', () => input.focus());

  function send() {
    const text = input.value.trim();
    if (text === '/new') {
      input.value = ''; syncPlaceholder();
      volyxLens.newSession();
      return;
    }
    if (!text) { runMode('assist', ''); return; }
    input.value = ''; syncPlaceholder();
    runMode('ask', text);
  }
  $('#send-btn').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) { e.preventDefault(); send(); }
    if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); runMode('assist', ''); }
  });

  // Smart toggle
  const smartBtn = $('#smart-toggle');
  $('#assist-context').addEventListener('change', async () => {
    settings.assistContext = $('#assist-context').value;
    await volyxLens.settingsSet({ assistContext: settings.assistContext });
    showStatus(`Assist will use: ${$('#assist-context').selectedOptions[0].textContent}.`);
  });
  smartBtn.addEventListener('click', async () => {
    settings.smart = !settings.smart;
    smartBtn.classList.toggle('on', settings.smart);
    await volyxLens.settingsSet({ smart: settings.smart });
  });

  // Hide / collapse
  $('#hide-btn').addEventListener('click', () => {
    const collapsed = $('#panel').classList.toggle('collapsed');
    $('#hide-btn').classList.toggle('collapsed', collapsed);
    $('#live-dot').style.display = collapsed ? 'none' : '';
  });

  // Start a fresh context without stopping active microphone/system capture.
  $('#new-session-btn').addEventListener('click', () => { volyxLens.newSession(); });

  function micEnabled() { return !settings || !settings.audio || settings.audio.micEnabled !== false; }
  function systemEnabled() { return !settings || !settings.audio || settings.audio.systemEnabled !== false; }
  function activeChannelCount() { return Number(micEnabled()) + Number(systemEnabled()); }

  // Start/stop listening. Kick off system-audio capture straight from the click so
  // the user-gesture is fresh for getDisplayMedia (loopback capture needs it).
  $('#stop-btn').addEventListener('click', async () => {
    const button = $('#stop-btn');
    if (button.disabled) return;
    const turningOn = !button.classList.contains('active');
    button.disabled = true;
    try {
      if (turningOn && systemEnabled() && volyxLens.platform !== 'darwin') startSystemAudio();
      await volyxLens.captureToggle();
    } catch (error) {
      showStatus(error && error.message ? error.message : 'Listening state could not be changed.');
    } finally {
      button.disabled = false;
    }
  });
  $('#kill-btn').addEventListener('click', () => volyxLens.quit());

  // ---- capture: microphone + system audio via AudioWorklet ----------------
  let micCapture = null, sysCapture = null;
  let micStartPromise = null, sysStartPromise = null;
  let captureEpoch = 0;

  function setAudioHealth(channel, status, level = null) {
    const isMic = channel === 'you';
    const stateEl = $(isMic ? '#mic-health' : '#system-health');
    const meterEl = $(isMic ? '#mic-meter' : '#system-meter');
    stateEl.textContent = status;
    stateEl.dataset.state = status.toLowerCase();
    if (level != null) meterEl.style.width = `${Math.min(100, Math.round(Math.sqrt(Math.max(0, level)) * 100))}%`;
  }

  async function createAudioCapture(stream, channel, sendPcm, onEnded = null) {
    const context = new AudioContext();
    let source = null, worklet = null, sink = null;
    try {
      await context.audioWorklet.addModule('audio-worklet.js');
      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length) throw new Error('No audio track was provided.');
      source = context.createMediaStreamSource(new MediaStream(audioTracks));
      worklet = new AudioWorkletNode(context, 'volyx-lens-pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { targetSampleRate: AUDIO_SAMPLE_RATE },
      });
      sink = context.createGain();
      sink.gain.value = 0;
      source.connect(worklet); worklet.connect(sink); sink.connect(context.destination);
      const format = { sourceSampleRate: context.sampleRate, targetSampleRate: AUDIO_SAMPLE_RATE };
      worklet.port.onmessage = ({ data }) => {
        if (!data) return;
        if (data.type === 'format') {
          format.sourceSampleRate = Number(data.sourceSampleRate) || context.sampleRate;
          format.targetSampleRate = Number(data.targetSampleRate) || AUDIO_SAMPLE_RATE;
          return;
        }
        if (data.type !== 'pcm') return;
        const sourceKhz = Math.round(format.sourceSampleRate / 100) / 10;
        const targetKhz = Math.round(format.targetSampleRate / 100) / 10;
        const formatLabel = format.sourceSampleRate === format.targetSampleRate ? `${targetKhz} kHz` : `${sourceKhz}→${targetKhz} kHz`;
        setAudioHealth(channel, `Receiving · ${formatLabel}`, data.level || 0);
        sendPcm(data.buffer, { ...format, level: data.level || 0 });
      };
      const capture = { stream, context, source, worklet, sink, format, closing: false };
      for (const track of audioTracks) track.addEventListener('ended', () => {
        if (!capture.closing && onEnded) onEnded();
      }, { once: true });
      return capture;
    } catch (error) {
      try { if (source) source.disconnect(); if (worklet) worklet.disconnect(); if (sink) sink.disconnect(); } catch {}
      try { await context.close(); } catch {}
      throw error;
    }
  }

  async function closeAudioCapture(capture) {
    if (!capture) return;
    capture.closing = true;
    capture.worklet.port.onmessage = null;
    try { capture.source.disconnect(); capture.worklet.disconnect(); capture.sink.disconnect(); } catch {}
    capture.stream.getTracks().forEach((track) => track.stop());
    try { await capture.context.close(); } catch {}
  }

  let unexpectedTrackEndPromise = null;
  function handleUnexpectedTrackEnd(channel) {
    if (unexpectedTrackEndPromise) return unexpectedTrackEndPromise;
    unexpectedTrackEndPromise = (async () => {
      captureEpoch += 1;
      await Promise.all([stopMic(), stopSystemAudio()]);
      await volyxLens.captureStop();
      listeningActive = false;
      $('#live-dot').classList.add('off');
      updateListeningButton(false);
      stopSessionClock();
      setAudioHealth(channel, 'Disconnected', 0);
      showStatus(`${channel === 'you' ? 'Microphone' : 'System audio'} disconnected. Listening stopped to prevent an idle billable session.`);
    })().finally(() => { unexpectedTrackEndPromise = null; });
    return unexpectedTrackEndPromise;
  }

  async function startMic() {
    if (micCapture) return micCapture;
    if (micStartPromise) return micStartPromise;
    setAudioHealth('you', 'Connecting', 0);
    const epoch = captureEpoch;
    micStartPromise = (async () => {
      let stream = null;
      try {
        const deviceId = settings.audio && settings.audio.inputDeviceId;
        stream = await navigator.mediaDevices.getUserMedia({ audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        } });
        const capture = await createAudioCapture(stream, 'you', (buffer) => volyxLens.micPcm(buffer), () => handleUnexpectedTrackEnd('you'));
        if (epoch !== captureEpoch) { await closeAudioCapture(capture); return null; }
        micCapture = capture;
        setAudioHealth('you', 'Connected', 0);
        return micCapture;
      } catch (error) {
        if (stream) stream.getTracks().forEach((track) => track.stop());
        setAudioHealth('you', 'Failed', 0);
        volyxLens.log('mic error: ' + (error && error.message));
        return null;
      } finally { micStartPromise = null; }
    })();
    return micStartPromise;
  }

  async function stopMic() {
    const capture = micCapture;
    micCapture = null;
    await closeAudioCapture(capture);
    setAudioHealth('you', 'Idle', 0);
  }

  async function startSystemAudio() {
    if (sysCapture) return sysCapture;
    if (sysStartPromise) return sysStartPromise;
    setAudioHealth('them', 'Connecting', 0);
    const epoch = captureEpoch;
    sysStartPromise = (async () => {
      let stream = null;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        stream.getVideoTracks().forEach((track) => track.stop());
        if (!stream.getAudioTracks().length) {
          stream.getTracks().forEach((track) => track.stop());
          throw new Error('No system-audio loopback track was provided.');
        }
        const capture = await createAudioCapture(stream, 'them', (buffer) => volyxLens.systemPcm(buffer), () => handleUnexpectedTrackEnd('them'));
        if (epoch !== captureEpoch) { await closeAudioCapture(capture); return null; }
        sysCapture = capture;
        setAudioHealth('them', 'Connected', 0);
        volyxLens.log('system audio: capturing loopback');
        return sysCapture;
      } catch (error) {
        if (stream) stream.getTracks().forEach((track) => track.stop());
        setAudioHealth('them', 'Failed', 0);
        volyxLens.log('system audio error: ' + (error && error.message));
        return null;
      } finally { sysStartPromise = null; }
    })();
    return sysStartPromise;
  }

  async function stopSystemAudio() {
    const capture = sysCapture;
    sysCapture = null;
    await closeAudioCapture(capture);
    setAudioHealth('them', 'Idle', 0);
  }

  let sessionStartedAt = 0;
  let sessionTimer = null;
  function formatDuration(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  function stopSessionClock() {
    if (sessionTimer) clearInterval(sessionTimer);
    sessionTimer = null;
    sessionStartedAt = 0;
    $('#session-duration').textContent = '00:00';
  }
  function startSessionClock() {
    stopSessionClock();
    sessionStartedAt = Date.now();
    sessionTimer = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - sessionStartedAt) / 1000);
      $('#session-duration').textContent = formatDuration(elapsedSeconds);
    }, 1000);
  }

  $('#retry-realtime-btn').addEventListener('click', async () => {
    const result = await volyxLens.retryRealtime();
    if (!result.ok) showStatus(result.message);
  });
  window.addEventListener('offline', () => showStatus('Network offline. Realtime remains stopped until you reconnect and press Retry.'));
  window.addEventListener('online', () => showStatus('Network restored. Press Retry to reconnect Realtime.'));

  function transcriptTime(ts) {
    try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    catch { return '--:--:--'; }
  }

  function normalizeTranscriptTurn(turn, partial = false) {
    const text = String((turn && turn.text) || '').trim();
    if (!text) return null;
    return {
      id: Number.isFinite(turn.id) ? turn.id : null,
      channel: turn.channel === 'you' ? 'you' : 'them',
      text,
      ts: Number.isFinite(turn.ts) ? turn.ts : Date.now(),
      partial,
    };
  }

  function appendTranscriptDisplayText(current, next) {
    const left = String(current || '').trim();
    const right = String(next || '').trim();
    if (!left) return right;
    if (!right) return left;
    const noSpace = /^[,.;:!?%)}\]]/.test(right) || /[\s([{\-–—/]$/.test(left);
    return `${left}${noSpace ? '' : ' '}${right}`;
  }

  function renderTranscriptWorkspace() {
    const workspace = $('#transcript-workspace');
    const list = $('#transcript-list');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 28;
    const partials = Object.values(partialTranscript).filter(Boolean).sort((a, b) => a.ts - b.ts);
    const rows = transcriptTurns.map((turn) => ({ ...turn, partial: false }));
    for (const partial of partials) {
      const activeTurn = rows[rows.length - 1];
      if (activeTurn && activeTurn.channel === partial.channel && !activeTurn.partial) {
        activeTurn.pendingText = partial.text;
        activeTurn.pendingTs = partial.ts;
      } else {
        rows.push({ ...partial, partial: true });
      }
    }
    const visibleRows = rows.slice(-200);
    const hideWorkspace = !listeningActive && visibleRows.length === 0;
    workspace.classList.toggle('hidden', hideWorkspace);
    if (hideWorkspace) {
      $('#session-diagnostics').classList.add('hidden');
      $('#diagnostics-toggle').setAttribute('aria-expanded', 'false');
      clearInterval(diagnosticsTimer); diagnosticsTimer = null;
    }
    list.replaceChildren();
    for (const turn of visibleRows) {
      const row = document.createElement('div');
      row.className = `transcript-turn ${turn.channel}${turn.partial ? ' partial' : ''}${turn.pendingText ? ' has-partial' : ''}`;
      const speaker = document.createElement('span'); speaker.className = 'transcript-speaker'; speaker.textContent = turn.channel === 'you' ? 'You' : 'Them';
      const text = document.createElement('span'); text.className = 'transcript-text'; text.textContent = turn.text;
      if (turn.pendingText) {
        const combined = appendTranscriptDisplayText(turn.text, turn.pendingText);
        const pending = document.createElement('span'); pending.className = 'transcript-pending'; pending.textContent = combined.slice(String(turn.text || '').length);
        text.appendChild(pending);
      }
      const time = document.createElement('time'); time.className = 'transcript-time'; time.dateTime = new Date(turn.pendingTs || turn.ts).toISOString(); time.textContent = turn.partial || turn.pendingText ? 'Listening…' : transcriptTime(turn.ts);
      row.append(speaker, text, time);
      if (!turn.partial && turn.id !== null) {
        const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'transcript-turn-copy'; copy.textContent = 'Copy'; copy.title = `Copy ${turn.channel === 'you' ? 'your' : 'their'} transcript turn`;
        copy.addEventListener('click', async () => {
          try { await volyxLens.transcriptCopyTurn(turn.id); showStatus('Transcript turn copied.'); }
          catch (error) { showStatus(error && error.message ? error.message : 'Transcript turn could not be copied.'); }
        });
        row.appendChild(copy);
      }
      list.appendChild(row);
    }
    const total = transcriptTurns.length;
    $('#transcript-count').textContent = `${total} ${total === 1 ? 'turn' : 'turns'}`;
    $('#transcript-empty').classList.toggle('hidden', visibleRows.length > 0);
    for (const id of ['transcript-copy', 'transcript-export', 'transcript-clear']) $(`#${id}`).disabled = total === 0;
    if (nearBottom || partials.length) list.scrollTop = list.scrollHeight;
  }

  function addTranscriptTurn(event) {
    const turn = normalizeTranscriptTurn(event);
    if (!turn) return;
    partialTranscript[turn.channel] = null;
    const duplicate = transcriptTurns.some((existing) => turn.id !== null ? existing.id === turn.id : (existing.channel === turn.channel && existing.ts === turn.ts && existing.text === turn.text));
    if (!duplicate) transcriptTurns.push(turn);
    if (transcriptTurns.length > 500) transcriptTurns = transcriptTurns.slice(-500);
    renderTranscriptWorkspace();
  }

  function updateTranscriptTurn(event) {
    const turn = normalizeTranscriptTurn(event);
    if (!turn) return;
    partialTranscript[turn.channel] = null;
    const index = transcriptTurns.findIndex((existing) => existing.id === turn.id);
    if (index >= 0) transcriptTurns[index] = turn;
    else transcriptTurns.push(turn);
    renderTranscriptWorkspace();
  }

  function setPartialTranscript(event) {
    const turn = normalizeTranscriptTurn(event, true);
    if (!turn) return;
    partialTranscript[turn.channel] = turn;
    renderTranscriptWorkspace();
  }

  function removeTranscriptTurn(event) {
    const id = Number(event && event.id);
    transcriptTurns = transcriptTurns.filter((turn) => turn.id !== id);
    if (event && ['you', 'them'].includes(event.channel)) partialTranscript[event.channel] = null;
    renderTranscriptWorkspace();
  }

  function clearSuppressedPartial(event) {
    const channel = event && event.channel === 'them' ? 'them' : 'you';
    partialTranscript[channel] = null;
    renderTranscriptWorkspace();
  }

  function clearTranscriptWorkspace() {
    transcriptTurns = [];
    partialTranscript.you = null;
    partialTranscript.them = null;
    clearQuestionSuggestion();
    renderTranscriptWorkspace();
  }

  function clearQuestionSuggestion() {
    $('#question-suggestion').classList.add('hidden');
    $('#question-suggestion-text').textContent = '';
  }

  function showQuestionSuggestion(event) {
    const text = String((event && event.text) || '').trim();
    if (!text) return;
    $('#question-suggestion-text').textContent = text;
    $('#question-suggestion').classList.remove('hidden');
  }

  $('#question-answer').addEventListener('click', () => {
    clearQuestionSuggestion();
    runMode('say', '');
  });
  $('#question-dismiss').addEventListener('click', clearQuestionSuggestion);

  function durationLabel(ms) {
    const seconds = Math.max(0, Math.floor(Number(ms) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}` : `${minutes}:${String(rest).padStart(2, '0')}`;
  }

  async function refreshDiagnostics() {
    if ($('#session-diagnostics').classList.contains('hidden')) return;
    try {
      const data = await volyxLens.diagnosticsGet();
      $('#diag-session').textContent = `${data.session.active ? 'Listening' : 'Idle'} · ${durationLabel(data.session.durationMs)}`;
      $('#diag-transcription').textContent = `${data.transcription.mode} · ${data.transcription.provider || 'none'}`;
      $('#diag-connections').textContent = `${data.transcription.connectedChannels}/${data.transcription.totalChannels}`;
      $('#diag-latency').textContent = data.transcription.lastLatencyMs == null ? '—' : `${data.transcription.lastLatencyMs} ms`;
      $('#diag-response').textContent = data.response.fallbackProvider ? `${data.response.defaultProvider} → ${data.response.fallbackProvider}` : data.response.defaultProvider;
      $('#diag-transcript').textContent = `${data.transcript.turns} turns · ${data.transcript.characters} chars`;
      $('#diag-last-state').textContent = data.transcription.lastStatus;
      const suppressed = Number(data.transcription.crossTalkSuppressed) || 0;
      $('#diag-cross-talk').textContent = `${suppressed} ${suppressed === 1 ? 'duplicate' : 'duplicates'} removed`;
    } catch (error) { showStatus(error && error.message ? error.message : 'Diagnostics are unavailable.'); }
  }

  $('#transcript-copy').addEventListener('click', async () => {
    try { const result = await volyxLens.transcriptCopy(); showStatus(`Copied ${result.turns} transcript ${result.turns === 1 ? 'turn' : 'turns'}.`); }
    catch (error) { showStatus(error && error.message ? error.message : 'Transcript could not be copied.'); }
  });
  $('#transcript-export').addEventListener('click', async () => {
    const button = $('#transcript-export'); button.disabled = true;
    try {
      const result = await volyxLens.transcriptExport($('#transcript-export-format').value);
      if (!result.canceled) showStatus(`Exported ${result.turns} turns to ${result.filename}.`);
    } catch (error) { showStatus(error && error.message ? error.message : 'Transcript could not be exported.'); }
    finally { button.disabled = transcriptTurns.length === 0; }
  });
  $('#transcript-clear').addEventListener('click', async () => {
    if (!window.confirm('Clear the current transcript? This does not delete exported files.')) return;
    try { await volyxLens.transcriptClear(); clearTranscriptWorkspace(); showStatus('Transcript cleared.'); }
    catch (error) { showStatus(error && error.message ? error.message : 'Transcript could not be cleared.'); }
  });
  $('#diagnostics-toggle').addEventListener('click', async () => {
    const panel = $('#session-diagnostics');
    const opening = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !opening);
    $('#diagnostics-toggle').setAttribute('aria-expanded', String(opening));
    clearInterval(diagnosticsTimer); diagnosticsTimer = null;
    if (opening) {
      await refreshDiagnostics();
      diagnosticsTimer = setInterval(refreshDiagnostics, 2000);
    }
  });
  $('#diagnostics-copy').addEventListener('click', async () => {
    try { await volyxLens.diagnosticsCopy(); showStatus('Sanitized diagnostics copied.'); }
    catch (error) { showStatus(error && error.message ? error.message : 'Diagnostics could not be copied.'); }
  });

  // ---- events from main --------------------------------------------------
  volyxLens.on('session:cleared', () => {
    clearMessages();
    clearTranscriptWorkspace();
    renderTaskContext({ count: 0, totalBytes: 0, pinnedCount: 0, lastCapturedAt: null, lastEviction: null, nearDuplicatesRejected: 0, fingerprintFailures: 0, ocrBytes: 0, ocrReadyCount: 0, ocrPendingCount: 0, ocrUnavailableCount: 0, ocrFailedCount: 0, ocrEvictedCount: 0, overlapLinkedCount: 0 });
    setTaskContextOpen(false);
    setBusy(false);
    input.value = '';
    syncPlaceholder();
  });
  volyxLens.on('capture:state', ({ active }) => {
    listeningActive = !!active;
    renderTranscriptWorkspace();
    $('#live-dot').classList.toggle('off', !active);
    $('#audio-health').classList.toggle('hidden', !active);
    updateListeningButton(active);
    if (active) {
      startSessionClock();
      if (micEnabled()) startMic(); else setAudioHealth('you', 'Disabled', 0);
      if (!systemEnabled()) setAudioHealth('them', 'Disabled', 0);
      else if (volyxLens.platform !== 'darwin') startSystemAudio();
    } else {
      captureEpoch += 1;
      stopSessionClock();
      stopMic();
      if (volyxLens.platform !== 'darwin') stopSystemAudio();
      partialTranscript.you = null; partialTranscript.them = null; renderTranscriptWorkspace();
      $('#connection-count').textContent = `0/${activeChannelCount()} connections`;
      $('#transcript-latency').textContent = 'Latency —';
    }
  });
  volyxLens.on('llm:start', ({ userBubble, small, contextSources, taskContextCount, taskContextTotalCount, responseProvider }) => {
    clearMessages();
    if (userBubble) addUserBubble(userBubble);
    addContextUsage(contextSources, taskContextCount, taskContextTotalCount, responseProvider);
    startAi(!!small);
    const inferredMode = String(userBubble || '').startsWith('Assist') ? 'assist' : activeRequestMode;
    setBusy(true, inferredMode);
  });
  volyxLens.on('llm:token', ({ text }) => appendToken(text));
  volyxLens.on('llm:provider', ({ label, fallback }) => updateResponseProvider(label, fallback));
  volyxLens.on('llm:done', () => { finalizeAi('Response ready.'); setBusy(false); });
  volyxLens.on('llm:canceled', () => {
    const partialKept = Boolean(aiEl && (aiEl.dataset.raw || '').trim());
    if (partialKept) finalizeAi('Response canceled. Partial response kept.');
    else {
      if (aiEl) { aiEl.remove(); aiEl = null; caretEl = null; }
      $('#assistant-status').textContent = 'Response canceled.';
    }
    setBusy(false);
  });
  volyxLens.on('llm:confirm-task-context', (event) => {
    setBusy(false);
    const currentNote = event.attachedCount ? ' plus the current screen' : '';
    const approved = window.confirm(`This request can upload ${event.attachedCount} saved Task Context screen${event.attachedCount === 1 ? '' : 's'}${currentNote} to ${event.provider}. Multiple images can increase latency and provider cost. Continue?`);
    if (!approved) { showStatus('Task Context request canceled before any screenshots were uploaded.'); return; }
    setBusy(true, event.mode);
    volyxLens.ask({ mode: event.mode, text: event.text || '', confirmedLongRecap: event.confirmedLongRecap === true, confirmedTaskContext: true });
  });
  volyxLens.on('llm:error', ({ message }) => {
    if (!aiEl) startAi(true);
    aiEl.dataset.raw = message; finalizeAi('Response failed.'); setBusy(false);
  });
  let statusTimer = null;
  function showStatus(message) {
    const settingsScrim = document.getElementById('settings-scrim');
    if (settingsScrim && !settingsScrim.classList.contains('hidden')) {
      const settingsStatus = $('#s-status');
      settingsStatus.textContent = message;
      settingsStatus.classList.add('show');
      return;
    }
    const el = document.getElementById('volyx-lens-status');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => el.classList.remove('show'), 11000);
  }
  volyxLens.on('status', ({ message }) => { volyxLens.log('[status] ' + message); showStatus(message); });

  volyxLens.on('task-context:state', renderTaskContext);
  volyxLens.on('transcript:partial', setPartialTranscript);
  volyxLens.on('transcript', addTranscriptTurn);
  volyxLens.on('transcript:update', updateTranscriptTurn);
  volyxLens.on('transcript:remove', removeTranscriptTurn);
  volyxLens.on('transcript:suppressed', clearSuppressedPartial);
  volyxLens.on('question:detected', showQuestionSuggestion);
  volyxLens.on('question:clear', clearQuestionSuggestion);
  volyxLens.on('transcript:cleared', clearTranscriptWorkspace);
  volyxLens.on('transcription:state', (event) => {
    if (event.status === 'source' && event.channel === 'them') {
      const labels = { connecting: 'Connecting', connected: 'Connected', failed: 'Failed', stopped: 'Idle' };
      setAudioHealth('them', labels[event.sourceState] || 'Idle', 0);
    }
    if (event.status === 'channel') {
      $('#connection-count').textContent = `${event.connectedChannels}/${event.totalChannels || 2} connections`;
    }
    if (event.status === 'latency') {
      const label = event.kind === 'first_partial' ? 'Partial' : 'Final';
      $('#transcript-latency').textContent = `${label} ${event.latencyMs} ms`;
    }
    if (event.status === 'activity') {
      const speaker = event.channel === 'you' ? 'You' : 'Them';
      $('#transcript-latency').textContent = event.activity === 'speech' ? `Hearing ${speaker}…` : `Processing ${speaker}…`;
    }
    if (event.status === 'item_failed') {
      const speaker = event.channel === 'you' ? 'You' : 'Them';
      $('#transcript-latency').textContent = `No speech from ${speaker}; still listening`;
    }
  });

  // ---- settings ----------------------------------------------------------
  const scrim = $('#settings-scrim');
  async function refreshAudioDevices() {
    const select = $('#audio-input-device');
    const selected = (settings.audio && settings.audio.inputDeviceId) || select.value || '';
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
      select.innerHTML = '<option value="">System default</option>';
      devices.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Microphone ${index + 1}`;
        select.appendChild(option);
      });
      select.value = devices.some((device) => device.deviceId === selected) ? selected : '';
    } catch (error) { volyxLens.log('audio device enumeration failed: ' + (error && error.message)); }
  }
  function renderPersonalContext() {
    const state = personalContext || { documents: {}, backend: 'unknown', secure: false, locked: false };
    for (const kind of ['resume', 'jobDescription']) {
      const documentState = state.documents[kind] || { present: false, enabled: false };
      const label = kind === 'resume' ? 'resume' : 'job description';
      const checkbox = $(`#context-${kind}-enabled`);
      const meta = $(`#context-${kind}-meta`);
      const preview = $(`#context-${kind}-preview`);
      const remove = document.querySelector(`.context-remove[data-kind="${kind}"]`);
      const importer = document.querySelector(`.context-import[data-kind="${kind}"]`);
      checkbox.disabled = !documentState.present || state.locked;
      checkbox.checked = !!documentState.enabled;
      meta.textContent = documentState.present
        ? `${documentState.name || `Saved ${label}`} · ${documentState.characters || 0} characters${documentState.truncated ? ' · truncated to safety limit' : ''}`
        : (state.locked ? `Saved ${label} is locked until secure storage is available.` : `No ${label} imported.`);
      preview.textContent = documentState.preview || '';
      preview.classList.toggle('hidden', !documentState.preview);
      remove.classList.toggle('hidden', !documentState.present);
      remove.disabled = state.locked;
      importer.disabled = state.locked;
    }
    const storage = state.locked ? 'Secure storage is locked; documents cannot be read or changed.'
      : (state.secure ? 'Extracted text is encrypted with safeStorage / macOS Keychain.' : 'Warning: safeStorage is unavailable; extracted text uses a local 0600 plaintext fallback.');
    $('#context-storage-status').textContent = `PDF, DOCX, TXT, or Markdown · 5 MB maximum. ${storage} Relevant excerpts are sent only when you request an answer.`;
  }

  function renderShortcutStatus(value) {
    shortcutStatus = Array.isArray(value) ? value : [];
    for (const status of shortcutStatus) {
      const row = document.querySelector(`.shortcut-status-row[data-shortcut="${status.id}"]`);
      if (!row) continue;
      row.classList.toggle('registered', status.registered === true);
      row.classList.toggle('unavailable', status.registered !== true);
      row.querySelector('kbd').textContent = status.displayAccelerator || status.accelerator;
      row.querySelector('strong').textContent = status.feature;
      row.querySelector('span').textContent = status.registered ? 'Registered globally' : `${status.message} ${status.fallback}`;
    }
    const unavailable = shortcutStatus.filter((status) => !status.registered).length;
    const retry = $('#shortcuts-retry');
    retry.disabled = unavailable === 0;
    retry.textContent = unavailable === 0 ? 'All registered' : `Retry unavailable (${unavailable})`;
  }

  async function refreshShortcutStatus({ retry = false } = {}) {
    const button = $('#shortcuts-retry');
    if (retry) { button.disabled = true; button.textContent = 'Retrying…'; }
    try {
      renderShortcutStatus(retry ? await volyxLens.shortcutsRetry() : await volyxLens.shortcutsGet());
    } catch (error) {
      if (retry) { button.disabled = false; button.textContent = 'Retry unavailable'; }
      showStatus(error && error.message ? error.message : 'Shortcut status is unavailable.');
    }
  }

  function selectSettingsSection(section, { focus = false } = {}) {
    const target = document.querySelector(`[data-settings-page="${section}"]`) || document.querySelector('[data-settings-page="providers"]');
    document.querySelectorAll('[data-settings-page]').forEach((page) => {
      const active = page === target;
      page.hidden = !active;
      page.classList.toggle('on', active);
    });
    document.querySelectorAll('[data-settings-section]').forEach((button) => {
      const active = button.dataset.settingsSection === target.dataset.settingsPage;
      button.classList.toggle('on', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    $('.s-pages').scrollTop = 0;
    if (focus) target.querySelector('h2').focus();
  }
  document.querySelectorAll('[data-settings-section]').forEach((button) => button.addEventListener('click', () => {
    selectSettingsSection(button.dataset.settingsSection, { focus: true });
  }));

  let settingsPreviousFocus = null;
  function settingsFocusable() {
    return [...$('#settings').querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.offsetParent !== null && element.style.visibility !== 'hidden');
  }
  function handleSettingsKeydown(event) {
    if (event.key === 'Escape') { event.preventDefault(); closeSettings(); return; }
    if (event.key !== 'Tab') return;
    const focusable = settingsFocusable();
    if (!focusable.length) { event.preventDefault(); return; }
    const current = focusable.indexOf(document.activeElement);
    if (current === -1) {
      event.preventDefault();
      focusable[event.shiftKey ? focusable.length - 1 : 0].focus();
    } else if (!event.shiftKey && current === focusable.length - 1) {
      event.preventDefault();
      focusable[0].focus();
    } else if (event.shiftKey && current === 0) {
      event.preventDefault();
      focusable[focusable.length - 1].focus();
    }
  }

  async function openSettings() {
    const activeElement = document.activeElement;
    settingsPreviousFocus = activeElement instanceof HTMLElement
      && activeElement !== document.body
      && activeElement.isConnected
      && !activeElement.closest('.hidden')
      ? activeElement
      : $('#more-btn');
    if (!personalContext) {
      try { personalContext = await volyxLens.personalContextGet(); }
      catch (error) { showStatus(error && error.message ? error.message : 'Personal context could not be loaded.'); }
    }
    providerView = settings.provider || 'openai';
    fillSettings();
    clearProviderTestResult();
    $('#provider-test-tier').value = settings.smart ? 'smart' : 'fast';
    renderPersonalContext();
    refreshAudioDevices();
    selectSettingsSection('providers');
    scrim.classList.remove('hidden');
    volyxLens.setModalState(true);
    requestAnimationFrame(() => document.querySelector('[data-settings-page="providers"] h2').focus());
    await refreshShortcutStatus();
  }
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', refreshAudioDevices);
  function hideSettingsAndRestoreFocus() {
    scrim.classList.add('hidden');
    volyxLens.setModalState(false);
    const target = settingsPreviousFocus && settingsPreviousFocus.isConnected ? settingsPreviousFocus : $('#more-btn');
    target.focus({ preventScroll: true });
    if (document.activeElement !== target) setTimeout(() => target.focus({ preventScroll: true }), 0);
  }
  async function closeSettings() {
    if (providerTestActive) { showStatus('Wait for the response-provider test to finish.'); $('#s-status').focus(); return; }
    try {
      await saveSettings();
      hideSettingsAndRestoreFocus();
    } catch (error) {
      showStatus(error && error.message ? error.message : 'Settings could not be saved.');
      $('#s-status').focus();
    }
  }
  $('#more-btn').addEventListener('click', openSettings);
  $('#s-close').addEventListener('click', closeSettings);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closeSettings(); });
  $('#shortcuts-retry').addEventListener('click', () => refreshShortcutStatus({ retry: true }));
  document.querySelectorAll('[data-shortcut-fallback]').forEach((button) => button.addEventListener('click', async () => {
    const action = button.dataset.shortcutFallback;
    if (action === 'quit') { volyxLens.quit(); return; }
    if (busy && (action === 'assist' || action === 'solve')) { showStatus('Stop the active answer before starting another one.'); return; }
    try {
      await saveSettings();
      hideSettingsAndRestoreFocus();
      if (action === 'assist') runMode('assist', '');
      else if (action === 'solve') runMode('leetcode', '');
      else if (action === 'task-context') await captureTaskContext();
    } catch (error) {
      showStatus(error && error.message ? error.message : 'The shortcut fallback could not run.');
    }
  }));

  function updateAudioSessionCount() {
    const mic = $('#audio-mic-enabled').checked;
    const system = $('#audio-system-enabled').checked;
    const count = Number(mic) + Number(system);
    const sources = [mic ? 'Mic' : null, system ? 'System' : null].filter(Boolean).join(' + ');
    $('#audio-session-count').textContent = `${count} active Realtime ${count === 1 ? 'session' : 'sessions'} when listening${sources ? ` — ${sources}` : ''}.`;
  }
  function enforceAudioChannelSelection() {
    if (!$('#audio-mic-enabled').checked && !$('#audio-system-enabled').checked) {
      $('#audio-mic-enabled').checked = true;
      showStatus('At least one audio channel must remain enabled.');
    }
    updateAudioSessionCount();
  }
  $('#audio-mic-enabled').addEventListener('change', enforceAudioChannelSelection);
  $('#audio-system-enabled').addEventListener('change', enforceAudioChannelSelection);

  const PROVIDER_LABELS = Object.freeze({ openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', azure: 'Azure Foundry', deepseek: 'DeepSeek' });
  function clearProviderTestResult() {
    const result = $('#provider-test-result');
    result.className = 'provider-test-result hidden';
    result.textContent = '';
  }
  function providerRouteLabel(route) {
    if (route === 'project') return 'Azure project endpoint';
    if (route === 'azure-openai-resource') return 'Azure OpenAI resource endpoint';
    if (route === 'foundry-resource') return 'Azure Foundry resource endpoint';
    return '';
  }
  function renderProviderConfig() {
    const label = PROVIDER_LABELS[providerView] || providerView;
    const present = (settings.credentialStatus && settings.credentialStatus.present) || {};
    document.querySelectorAll('#provider-seg button').forEach((button) => {
      const selected = button.dataset.provider === providerView;
      button.classList.toggle('on', selected);
      button.classList.toggle('default-provider', button.dataset.provider === settings.provider);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    $('#provider-config-panel').setAttribute('aria-labelledby', `provider-tab-${providerView}`);
    document.querySelectorAll('[data-provider-config]').forEach((row) => row.classList.toggle('hidden', row.dataset.providerConfig !== providerView));
    $('#provider-view-title').textContent = label;
    const isDefault = providerView === settings.provider;
    $('#provider-view-state').textContent = isDefault ? 'Default response provider' : (present[providerView] ? 'API key saved' : 'Not configured');
    $('#provider-default-btn').disabled = isDefault;
    $('#provider-default-btn').textContent = isDefault ? 'Current default' : 'Use as default';
    $('#provider-key-label').childNodes[0].nodeValue = `${label} API key `;
    $('#provider-model-hint').textContent = providerView === 'azure' ? 'exact Azure deployment names' : `used by ${label}`;
    $('#provider-capability-note').classList.toggle('hidden', providerView !== 'deepseek');
    const models = settings.models[providerView] || { fast: '', smart: '' };
    $('#model-fast').value = models.fast || '';
    $('#model-smart').value = models.smart || '';
    const fallback = $('#provider-fallback');
    [...fallback.options].forEach((option) => { option.disabled = option.value === settings.provider; });
    if (settings.fallbackProvider === settings.provider) settings.fallbackProvider = '';
    fallback.value = settings.fallbackProvider || '';
  }

  function renderTranscriptionProviderConfig() {
    const selected = $('#stt-realtime-provider').value;
    document.querySelectorAll('.stt-provider-config').forEach((row) => row.classList.toggle('hidden', row.dataset.sttProvider !== selected));
  }

  function fillSettings() {
    const credentialStatus = settings.credentialStatus || { present: {} };
    const keyPlaceholders = { openai: 'sk-...', anthropic: 'sk-ant-...', gemini: 'AIza...', azure: 'Foundry resource key', deepseek: 'sk-...', azureRealtime: 'Optional separate Realtime resource key' };
    for (const provider of Object.keys(keyPlaceholders)) {
      const input = $(`#key-${provider}`);
      input.value = '';
      input.placeholder = credentialStatus.present[provider] ? 'Saved securely — enter to replace' : keyPlaceholders[provider];
      const clear = document.querySelector(`.key-clear[data-key="${provider}"]`);
      if (clear) clear.disabled = !credentialStatus.present[provider];
    }
    $('#endpoint-azure').value = (settings.endpoints && settings.endpoints.azure) || '';
    $('#endpoint-azure-realtime').value = (settings.endpoints && settings.endpoints.azureRealtime) || '';
    const transcription = settings.transcription || {};
    $('#stt-mode').value = transcription.mode || 'realtime';
    $('#stt-realtime-provider').value = transcription.realtimeProvider || 'openai';
    renderTranscriptionProviderConfig();
    $('#stt-azure-deployment').value = transcription.azureRealtimeDeployment || '';
    $('#stt-language').value = transcription.language || '';
    $('#stt-delay').value = transcription.delay || 'low';
    $('#stt-fallback-model').value = transcription.fallbackModel || 'gpt-4o-mini-transcribe';
    $('#stt-gemini-fallback-model').value = transcription.geminiFallbackModel || 'gemini-3.5-flash';
    $('#stt-offline-enabled').checked = transcription.offlineEnabled === true;
    $('#stt-offline-cloud-fallback').checked = transcription.offlineCloudFallback === true;
    const audio = settings.audio || {};
    $('#audio-input-device').value = audio.inputDeviceId || '';
    $('#audio-mic-enabled').checked = audio.micEnabled !== false;
    $('#audio-system-enabled').checked = audio.systemEnabled !== false;
    $('#question-detection-enabled').checked = settings.questionDetection !== false;
    updateAudioSessionCount();
    $('#audio-sensitivity').value = audio.sensitivity || 'balanced';
    $('#audio-silence').value = String(audio.silenceMs || 700);
    $('#audio-cost-warning').value = String(audio.costWarningMinutes || 30);
    $('#audio-session-limit').value = String(audio.maxSessionMinutes || 60);
    renderProviderConfig();
    $('#s-status').textContent = statusText();
  }
  function statusText() {
    const present = (settings.credentialStatus && settings.credentialStatus.present) || {};
    const transcription = settings.transcription || {};
    let stt = 'none';
    if (transcription.mode === 'batch') stt = present.openai ? 'OpenAI batch' : (present.gemini ? 'Gemini batch' : 'none');
    else if (transcription.realtimeProvider === 'azure') stt = (present.azureRealtime || present.azure) ? 'Azure Realtime' : 'Azure Realtime (key missing)';
    else stt = present.openai ? 'OpenAI Realtime' : 'OpenAI Realtime (key missing)';
    const backend = settings.credentialStatus && settings.credentialStatus.backend;
    const storage = settings.credentialStatus && settings.credentialStatus.secure ? 'secure storage' : (backend === 'locked-safeStorage' ? 'secure storage locked' : 'plaintext fallback');
    const defaultLabel = PROVIDER_LABELS[settings.provider] || settings.provider;
    const fallbackLabel = settings.fallbackProvider ? (PROVIDER_LABELS[settings.fallbackProvider] || settings.fallbackProvider) : 'none';
    return `${defaultLabel} default · ${fallbackLabel} fallback · ${stt} · ${storage}`;
  }
  function stashCurrentModels() {
    if (!settings.models[providerView]) settings.models[providerView] = {};
    settings.models[providerView].fast = $('#model-fast').value.trim();
    settings.models[providerView].smart = $('#model-smart').value.trim();
  }
  document.querySelectorAll('#provider-seg button').forEach((button) => button.addEventListener('click', () => {
    stashCurrentModels();
    providerView = button.dataset.provider;
    clearProviderTestResult();
    renderProviderConfig();
  }));
  $('#provider-seg').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...document.querySelectorAll('#provider-seg [role="tab"]')];
    const current = Math.max(0, tabs.indexOf(document.activeElement));
    let next = current;
    if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
    if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    event.preventDefault();
    tabs[next].click();
    tabs[next].focus();
  });
  $('#provider-default-btn').addEventListener('click', () => {
    stashCurrentModels();
    settings.provider = providerView;
    if (settings.fallbackProvider === providerView) settings.fallbackProvider = '';
    renderProviderConfig();
    $('#s-status').textContent = statusText();
  });
  $('#provider-fallback').addEventListener('change', (event) => {
    settings.fallbackProvider = event.target.value === settings.provider ? '' : event.target.value;
    renderProviderConfig();
    $('#s-status').textContent = statusText();
  });
  $('#stt-realtime-provider').addEventListener('change', renderTranscriptionProviderConfig);
  document.querySelectorAll('.key-clear').forEach((button) => button.addEventListener('click', async () => {
    const provider = button.dataset.key;
    try {
      await saveSettings();
      settings = await volyxLens.clearCredential(provider);
      fillSettings();
      showStatus(`${provider} API key removed.`);
    } catch (error) {
      showStatus(error && error.message ? error.message : 'The API key could not be removed.');
    }
  }));
  document.querySelectorAll('.context-import').forEach((button) => button.addEventListener('click', async () => {
    const kind = button.dataset.kind;
    button.disabled = true;
    const original = button.textContent;
    button.textContent = 'Importing…';
    try {
      const result = await volyxLens.personalContextImport(kind);
      personalContext = result;
      renderPersonalContext();
      if (!result.canceled) showStatus(`${kind === 'resume' ? 'Resume' : 'Job description'} imported locally.`);
    } catch (error) {
      showStatus(error && error.message ? error.message : 'The document could not be imported.');
    } finally {
      button.textContent = original;
      if (!(personalContext && personalContext.locked)) button.disabled = false;
    }
  }));
  document.querySelectorAll('.context-remove').forEach((button) => button.addEventListener('click', async () => {
    const kind = button.dataset.kind;
    const label = kind === 'resume' ? 'resume/CV' : 'job description';
    if (!window.confirm(`Remove Volyx Lens's extracted ${label} text? The original file will not be changed.`)) return;
    try {
      personalContext = await volyxLens.personalContextRemove(kind);
      renderPersonalContext();
      showStatus(`${label} removed from Volyx Lens.`);
    } catch (error) { showStatus(error && error.message ? error.message : 'The document could not be removed.'); }
  }));
  for (const kind of ['resume', 'jobDescription']) {
    $(`#context-${kind}-enabled`).addEventListener('change', async (event) => {
      event.target.disabled = true;
      try {
        personalContext = await volyxLens.personalContextSetEnabled(kind, event.target.checked);
        renderPersonalContext();
      } catch (error) {
        showStatus(error && error.message ? error.message : 'Personal context could not be updated.');
        renderPersonalContext();
      }
    });
  }

  async function saveSettings() {
    const apiKeyUpdates = {};
    for (const provider of ['openai', 'anthropic', 'gemini', 'azure', 'deepseek', 'azureRealtime']) {
      const value = $(`#key-${provider}`).value.trim();
      if (value) apiKeyUpdates[provider] = value;
    }
    if (!settings.endpoints) settings.endpoints = {};
    settings.endpoints.azure = $('#endpoint-azure').value.trim();
    settings.endpoints.azureRealtime = $('#endpoint-azure-realtime').value.trim();
    settings.questionDetection = $('#question-detection-enabled').checked;
    if (!settings.questionDetection) clearQuestionSuggestion();
    settings.transcription = {
      ...(settings.transcription || {}),
      mode: $('#stt-mode').value,
      realtimeProvider: $('#stt-realtime-provider').value,
      realtimeModel: 'gpt-realtime-whisper',
      azureRealtimeDeployment: $('#stt-azure-deployment').value.trim(),
      fallbackModel: $('#stt-fallback-model').value.trim() || 'gpt-4o-mini-transcribe',
      geminiFallbackModel: $('#stt-gemini-fallback-model').value.trim() || 'gemini-3.5-flash',
      offlineEnabled: $('#stt-offline-enabled').checked,
      offlineCloudFallback: $('#stt-offline-cloud-fallback').checked,
      language: ['auto', 'automatic'].includes($('#stt-language').value.trim().toLowerCase()) ? '' : $('#stt-language').value.trim().toLowerCase(),
      delay: $('#stt-delay').value
    };
    settings.audio = {
      ...(settings.audio || {}),
      inputDeviceId: $('#audio-input-device').value,
      micEnabled: $('#audio-mic-enabled').checked,
      systemEnabled: $('#audio-system-enabled').checked,
      sensitivity: $('#audio-sensitivity').value,
      silenceMs: Math.max(300, Math.min(2000, Number($('#audio-silence').value) || 700)),
      preRollMs: 250,
      costWarningMinutes: Math.max(5, Math.min(240, Number($('#audio-cost-warning').value) || 30)),
      maxSessionMinutes: Math.max(10, Math.min(480, Number($('#audio-session-limit').value) || 60)),
    };
    stashCurrentModels();
    settings = await volyxLens.settingsSet({ ...settings, apiKeyUpdates });
    fillSettings();
  }

  $('#provider-test-btn').addEventListener('click', async () => {
    const button = $('#provider-test-btn');
    const resultEl = $('#provider-test-result');
    const testedProvider = providerView;
    const testedTier = $('#provider-test-tier').value === 'smart' ? 'smart' : 'fast';
    const controls = [...document.querySelectorAll('#provider-seg button, #provider-default-btn, #provider-fallback, #model-fast, #model-smart, #endpoint-azure, #provider-test-tier, #s-close')];
    const disabledBefore = new Map(controls.map((control) => [control, control.disabled]));
    providerTestActive = true;
    controls.forEach((control) => { control.disabled = true; });
    button.disabled = true;
    button.textContent = 'Testing…';
    resultEl.className = 'provider-test-result';
    resultEl.textContent = 'Saving settings, then sending one minimal text-only request…';
    try {
      await saveSettings();
      const result = await volyxLens.testResponseProvider(testedProvider, testedTier);
      if (providerView !== testedProvider) return;
      resultEl.className = `provider-test-result ${result.ok ? 'ok' : 'error'}`;
      const tierLabel = result.tier === 'smart' ? 'Smart' : 'Fast';
      const route = providerRouteLabel(result.route);
      const details = [result.label, `${tierLabel}: ${result.model || 'not configured'}`, route, result.supportsVision ? 'vision capable' : 'text only', result.latencyMs ? `${result.latencyMs} ms` : ''].filter(Boolean).join(' · ');
      resultEl.textContent = `${result.ok ? 'Passed' : 'Failed'} · ${details}. ${result.message}`;
    } catch (error) {
      resultEl.className = 'provider-test-result error';
      resultEl.textContent = `Failed · diagnostic unavailable. ${error && error.message ? error.message : 'The provider test could not run.'}`;
    } finally {
      providerTestActive = false;
      disabledBefore.forEach((disabled, control) => { control.disabled = disabled; });
      button.disabled = false;
      button.textContent = 'Test connection';
      renderProviderConfig();
    }
  });

  $('#test-realtime-btn').addEventListener('click', async () => {
    const button = $('#test-realtime-btn');
    const resultEl = $('#realtime-test-result');
    button.disabled = true;
    button.textContent = 'Testing…';
    resultEl.className = 's-diag-result running';
    resultEl.textContent = 'Opening one short no-audio Realtime session…';
    try {
      await saveSettings();
      const result = await volyxLens.testRealtime();
      resultEl.className = `s-diag-result ${result.ok ? 'success' : 'error'}`;
      if (result.ok) {
        resultEl.textContent = `Passed in ${result.elapsedMs} ms. Endpoint, authentication, deployment, and session settings were accepted.`;
      } else {
        const status = result.status ? ` · HTTP ${result.status}` : '';
        resultEl.textContent = `${result.stage}${status} · ${result.code}: ${result.message}`;
      }
    } catch (error) {
      resultEl.className = 's-diag-result error';
      resultEl.textContent = `diagnostic · ipc_error: ${error && error.message ? error.message : 'The diagnostic could not run.'}`;
    } finally {
      button.disabled = false;
      button.textContent = 'Test Connection';
    }
  });

  $('#test-live-transcription-btn').addEventListener('click', async () => {
    const button = $('#test-live-transcription-btn');
    const connectionButton = $('#test-realtime-btn');
    const listenButton = $('#stop-btn');
    const resultEl = $('#realtime-test-result');
    let capture = null;
    let stream = null;
    let diagnosticStarted = false;
    button.disabled = true;
    connectionButton.disabled = true;
    listenButton.disabled = true;
    button.textContent = 'Connecting…';
    resultEl.className = 's-diag-result running';
    resultEl.textContent = 'Checking microphone permission…';
    try {
      await saveSettings();
      const permission = await volyxLens.requestPermission('microphone');
      if (!permission || permission.granted !== true) {
        resultEl.className = 's-diag-result error';
        resultEl.textContent = 'microphone · permission_denied: Allow Volyx Lens in System Settings → Privacy & Security → Microphone, then restart the app.';
        return;
      }
      resultEl.textContent = 'Opening a one-channel Realtime session…';
      const started = await volyxLens.startLiveTranscriptionTest();
      if (!started.ok) {
        resultEl.className = 's-diag-result error';
        resultEl.textContent = `${started.stage} · ${started.code}: ${started.message}`;
        return;
      }
      diagnosticStarted = true;
      const deviceId = settings.audio && settings.audio.inputDeviceId;
      stream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      } });
      capture = await createAudioCapture(stream, 'you', (buffer, metadata) => volyxLens.liveTranscriptionPcm(buffer, metadata));
      stream = null;
      for (let remaining = 5; remaining > 0; remaining -= 1) {
        button.textContent = `Speak · ${remaining}s`;
        resultEl.textContent = `Speak normally into the selected microphone for ${remaining} more second${remaining === 1 ? '' : 's'}…`;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      await closeAudioCapture(capture);
      capture = null;
      button.textContent = 'Transcribing…';
      resultEl.textContent = 'Waiting for a final transcript and sanitized telemetry…';
      const result = await volyxLens.finishLiveTranscriptionTest();
      diagnosticStarted = false;
      const sourceKhz = Math.round((result.sourceSampleRate || AUDIO_SAMPLE_RATE) / 100) / 10;
      const targetKhz = Math.round((result.targetSampleRate || AUDIO_SAMPLE_RATE) / 100) / 10;
      const telemetry = `${sourceKhz}→${targetKhz} kHz · ${result.durationMs || 0} ms · ${result.bytesSent || 0} bytes · ${result.commitCount || 0} commits · ${result.endpointHost || result.provider || 'provider'} · ${result.deployment || 'deployment'}`;
      resultEl.className = `s-diag-result ${result.ok ? 'success' : 'error'}`;
      resultEl.textContent = result.ok
        ? `Passed: “${result.transcript}” · ${telemetry}`
        : `${result.stage} · ${result.code}: ${result.message} · ${telemetry}`;
    } catch (error) {
      resultEl.className = 's-diag-result error';
      const permissionDenied = error && (error.name === 'NotAllowedError' || /permission denied/i.test(error.message || ''));
      resultEl.textContent = permissionDenied
        ? 'microphone · permission_denied: macOS or Electron denied microphone capture. Restart Volyx Lens after granting access.'
        : 'live diagnostic · ipc_error: The live microphone test could not run.';
    } finally {
      if (capture) await closeAudioCapture(capture);
      if (stream) stream.getTracks().forEach((track) => track.stop());
      if (diagnosticStarted) {
        try { await volyxLens.finishLiveTranscriptionTest(); } catch {}
      }
      button.disabled = false;
      connectionButton.disabled = false;
      listenButton.disabled = false;
      button.textContent = 'Test Live Mic';
    }
  });

  // Prevent dropped files or links from navigating the privileged renderer.
  for (const eventName of ['dragover', 'drop']) {
    document.addEventListener(eventName, (event) => event.preventDefault());
  }

  // ---- global keys -------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (!obScrim.classList.contains('hidden')) {
      handleOnboardKeydown(e);
      return;
    }
    if (!scrim.classList.contains('hidden')) { handleSettingsKeydown(e); return; }
    if (e.metaKey && e.key === ',') { e.preventDefault(); openSettings(); }
  });

  // ---- click-through: only the UI blocks the mouse; empty gaps pass to your screen ----
  let ignoring = null;
  function setIgnore(v) { if (v !== ignoring) { ignoring = v; volyxLens.setIgnoreMouse(v); } }
  document.addEventListener('mousemove', (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const overUI = !!(el && el.closest && el.closest('#toolbar, #panel-wrap, #settings-scrim, #onboard-scrim'));
    setIgnore(!overUI);
  });
  setIgnore(true); // start fully click-through; hovering the panel re-enables it

  // ---- onboarding / first-run tutorial -----------------------------------
  const obScrim = $('#onboard-scrim');
  const obPermissionStatus = $('#ob-permission-status');
  const permissionStates = {
    microphone: { text: 'Not requested', className: '' },
    screen: { text: 'Not requested', className: '' }
  };
  let obPreviousFocus = null;
  function setPermissionState(kind, text, className = '') {
    permissionStates[kind] = { text, className };
    const state = document.querySelector(`[data-permission-kind="${kind}"] .ob-permission-state`);
    if (state) {
      state.textContent = text;
      state.className = `ob-permission-state ${className}`.trim();
    }
  }
  async function requestPermission(kind) {
    const label = kind === 'microphone' ? 'Microphone' : 'Screen Recording';
    setPermissionState(kind, 'Requesting…', 'pending');
    obPermissionStatus.textContent = 'Requesting ' + label + ' access…';
    obPermissionStatus.className = 'ob-permission-status pending';
    try {
      const result = await volyxLens.requestPermission(kind);
      if (result.granted) {
        setPermissionState(kind, 'Granted', 'granted');
        obPermissionStatus.textContent = label + ' access granted.';
        obPermissionStatus.className = 'ob-permission-status granted';
      } else if (result.settingsOpened) {
        setPermissionState(kind, 'Needs settings', 'denied');
        obPermissionStatus.textContent = label + ' access was not granted. Enable Volyx Lens in System Settings, then restart Volyx Lens.';
        const restart = document.createElement('button');
        restart.type = 'button';
        restart.textContent = 'Restart Volyx Lens';
        restart.addEventListener('click', () => volyxLens.relaunch());
        obPermissionStatus.append(' ', restart);
        obPermissionStatus.className = 'ob-permission-status denied';
      } else {
        setPermissionState(kind, 'Unavailable', 'denied');
        obPermissionStatus.textContent = result.message || (label + ' access is unavailable.');
        obPermissionStatus.className = 'ob-permission-status denied';
      }
    } catch (error) {
      setPermissionState(kind, 'Request failed', 'denied');
      obPermissionStatus.textContent = 'Could not request ' + label + ' access: ' + ((error && error.message) || 'unknown error');
      obPermissionStatus.className = 'ob-permission-status denied';
    }
  }
  async function refreshPermissionStates() {
    const results = await Promise.all(['microphone', 'screen'].map(async (kind) => {
      try { return await volyxLens.permissionStatus(kind); }
      catch { return { kind, status: 'unknown', granted: false }; }
    }));
    for (const result of results) {
      if (result.granted) setPermissionState(result.kind, 'Granted', 'granted');
      else if (['denied', 'restricted'].includes(result.status)) setPermissionState(result.kind, 'Needs settings', 'denied');
      else if (result.status === 'unsupported') setPermissionState(result.kind, 'Unavailable', 'denied');
      else setPermissionState(result.kind, 'Not requested', '');
    }
    if (obIndex === 1) renderOnboard();
  }
  const OB_STEPS = [
    {
      stepLabel: 'Welcome',
      icon: 'logo',
      kicker: 'Context, your way',
      note: 'A quiet assistant that stays available without taking over your workspace.',
      title: 'Meet Volyx Lens.',
      body: '<p>A private, context-aware assistant for the work already happening on your Mac.</p><div class="ob-feature-grid"><div class="ob-feature"><strong>See</strong><span>Use the screen only when you ask.</span></div><div class="ob-feature"><strong>Hear</strong><span>Keep both sides of a conversation clear.</span></div><div class="ob-feature"><strong>Assist</strong><span>Get focused help without changing apps.</span></div></div><div class="ob-note">Capture exclusion is best-effort and never guaranteed.</div>'
    },
    {
      stepLabel: 'Permissions',
      icon: 'mic',
      kicker: 'You stay in control',
      note: 'macOS permission prompts come from the system. Volyx Lens cannot bypass them.',
      title: 'Choose access.',
      body: '<p>Grant only the inputs you want to use. Each permission is optional, and you can continue without granting either one.</p><div class="ob-note">Camera access is never requested. Change access later in System Settings.</div>',
      buttons: [
        { kind: 'microphone', icon: 'mic', label: 'Microphone', detail: 'Your voice while listening is on', action: () => requestPermission('microphone') },
        { kind: 'screen', icon: 'camera', label: 'Screen Recording', detail: 'Screen context and meeting-audio loopback', action: () => requestPermission('screen') }
      ]
    },
    {
      stepLabel: 'AI provider',
      icon: 'settings',
      kicker: 'Bring your own model',
      note: 'Keys stay in the main process and use macOS Keychain-backed safeStorage when available.',
      title: 'Connect your AI provider.',
      body: '<p>Choose OpenAI, Anthropic, Gemini, <span class="hl">Azure Foundry</span>, or DeepSeek. Your provider receives context only when you run an answer action.</p><div class="ob-note">Response and transcription providers are configured separately.</div>',
      buttons: [{ icon: 'settings', label: 'Open provider settings', detail: 'Add a key, endpoint, and model names', action: async () => {
        if (await finishOnboard({ restoreFocus: false, keepModalState: true })) await openSettings();
      } }]
    },
    {
      stepLabel: 'Screen sharing',
      icon: 'camera',
      kicker: 'Best-effort privacy',
      note: 'Content protection reduces accidental exposure; it is not invisibility.',
      title: 'Know what others can see.',
      body: '<p>Volyx Lens asks macOS to exclude its window from many captures. Modern capture tools may still ignore that request.</p><div class="permission-card"><span class="permission-mark">Z</span><div><strong>Zoom</strong><span>Choose “Advanced capture with window filtering” in Share Screen settings.</span></div></div><div class="ob-note">Never rely on capture exclusion for proctored, restricted, or consent-sensitive sessions.</div>'
    },
    {
      stepLabel: 'Ready',
      icon: 'zap',
      kicker: 'Ready when you are',
      note: 'Reopen this guide anytime by selecting the Volyx Lens logo in the toolbar.',
      title: 'Your workspace, now context-aware.',
      body: '<p>Start with these four controls. Everything else can wait until you need it.</p><div class="ob-shortcuts"><div class="ob-shortcut"><span class="kbd">⌘↵</span><span>Run Assist</span></div><div class="ob-shortcut"><span class="kbd">⌘H</span><span>Solve screen</span></div><div class="ob-shortcut"><span class="kbd">⌘⇧C</span><span>Add context</span></div><div class="ob-shortcut"><span class="kbd">⌘⇧X</span><span>Stop and quit</span></div></div>'
    }
  ];
  let obIndex = 0;
  $('#ob-brand-mark').innerHTML = icon('logo', { size: 19 });
  function renderOnboard() {
    const step = OB_STEPS[obIndex];
    $('#ob-icon').innerHTML = icon(step.icon, { size: 30, stroke: 1.7 });
    $('#ob-step-label').textContent = step.stepLabel;
    $('#ob-step-count').textContent = `${obIndex + 1} of ${OB_STEPS.length}`;
    $('#ob-stage-kicker').textContent = step.kicker;
    $('#ob-stage-note').textContent = step.note;
    $('#ob-title').textContent = step.title;
    $('#ob-body').innerHTML = step.body;
    const btns = $('#ob-buttons'); btns.replaceChildren();
    obPermissionStatus.textContent = '';
    obPermissionStatus.className = 'ob-permission-status hidden';
    (step.buttons || []).forEach((definition) => {
      const button = document.createElement('button');
      button.type = 'button';
      if (definition.kind) button.dataset.permissionKind = definition.kind;
      const buttonIcon = document.createElement('span');
      buttonIcon.className = 'ob-button-icon';
      buttonIcon.innerHTML = icon(definition.icon, { size: 16, stroke: 1.8 });
      const copy = document.createElement('span');
      copy.className = 'ob-button-copy';
      const label = document.createElement('strong');
      label.textContent = definition.label;
      const detail = document.createElement('small');
      detail.textContent = definition.detail;
      copy.append(label, detail);
      const trailing = document.createElement('span');
      if (definition.kind) {
        const state = permissionStates[definition.kind];
        trailing.className = `ob-permission-state ${state.className}`.trim();
        trailing.textContent = state.text;
      } else {
        trailing.className = 'ob-button-arrow';
        trailing.textContent = '›';
      }
      button.append(buttonIcon, copy, trailing);
      button.addEventListener('click', definition.action);
      btns.appendChild(button);
    });
    const dots = $('#ob-dots'); dots.replaceChildren();
    OB_STEPS.forEach((item, index) => {
      const dot = document.createElement('span');
      if (index === obIndex) {
        dot.className = 'on';
        dot.setAttribute('aria-current', 'step');
      }
      dot.setAttribute('aria-label', `${item.stepLabel}: step ${index + 1}`);
      dots.appendChild(dot);
    });
    $('#ob-back').style.visibility = obIndex === 0 ? 'hidden' : 'visible';
    $('#ob-next').textContent = obIndex === OB_STEPS.length - 1 ? 'Start using Lens' : 'Continue';
    $('#ob-skip').style.visibility = obIndex === OB_STEPS.length - 1 ? 'hidden' : 'visible';
  }
  function onboardFocusable() {
    return [...$('#onboard').querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.offsetParent !== null && element.style.visibility !== 'hidden');
  }
  function handleOnboardKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      finishOnboard();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = onboardFocusable();
    if (!focusable.length) { event.preventDefault(); return; }
    const current = focusable.indexOf(document.activeElement);
    if (current === -1) {
      event.preventDefault();
      focusable[event.shiftKey ? focusable.length - 1 : 0].focus();
    } else if (!event.shiftKey && current === focusable.length - 1) {
      event.preventDefault();
      focusable[0].focus();
    } else if (event.shiftKey && current === 0) {
      event.preventDefault();
      focusable[focusable.length - 1].focus();
    }
  }
  function showOnboard() {
    obPreviousFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : $('#logo-btn');
    obIndex = 0;
    renderOnboard();
    obScrim.classList.remove('hidden');
    volyxLens.setModalState(true);
    setIgnore(false);
    requestAnimationFrame(() => $('#ob-title').focus());
    void refreshPermissionStates();
  }
  async function finishOnboard({ restoreFocus = true, keepModalState = false } = {}) {
    if (settings && !settings.onboarded) {
      try {
        await volyxLens.settingsSet({ onboarded: true });
        settings.onboarded = true;
      } catch {
        $('#ob-permission-status').textContent = 'Setup could not be saved. Review your local storage permissions and try again.';
        $('#ob-permission-status').classList.remove('hidden');
        $('#ob-permission-status').focus?.();
        volyxLens.setModalState(true);
        return false;
      }
    }
    obScrim.classList.add('hidden');
    if (!keepModalState) volyxLens.setModalState(false);
    if (restoreFocus) requestAnimationFrame(() => (obPreviousFocus && obPreviousFocus.isConnected ? obPreviousFocus : $('#logo-btn')).focus());
    return true;
  }
  $('#ob-next').addEventListener('click', () => { if (obIndex === OB_STEPS.length - 1) finishOnboard(); else { obIndex++; renderOnboard(); $('#ob-title').focus(); } });
  $('#ob-back').addEventListener('click', () => { if (obIndex > 0) { obIndex--; renderOnboard(); $('#ob-title').focus(); } });
  $('#ob-skip').addEventListener('click', finishOnboard);
  $('#logo-btn').addEventListener('click', showOnboard);

  // ---- boot --------------------------------------------------------------
  (async function boot() {
    let existingTranscript;
    [settings, personalContext, existingTranscript, taskContext] = await Promise.all([volyxLens.settingsGet(), volyxLens.personalContextGet(), volyxLens.transcriptGet(), volyxLens.taskContextGet()]);
    transcriptTurns = (Array.isArray(existingTranscript) ? existingTranscript : []).map((turn) => normalizeTranscriptTurn(turn)).filter(Boolean);
    renderTaskContext(taskContext);
    smartBtn.classList.toggle('on', !!settings.smart);
    $('#assist-context').value = settings.assistContext || 'both';
    clearMessages();
    syncPlaceholder();
    const st = await volyxLens.captureState();
    listeningActive = !!st.active;
    renderTranscriptWorkspace();
    $('#live-dot').classList.toggle('off', !st.active);
    updateListeningButton(st.active);
    if (!settings.onboarded) showOnboard();
    else volyxLens.setModalState(false);
    volyxLens.rendererReady();
  })();
})();
