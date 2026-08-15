# Voice upgrade plan

## Goal

Turn Volyx Lens's fixed 3.5-second upload loop into a low-latency, provider-neutral transcription pipeline that preserves separate **You** and **Them** channels and can later support automatic question detection.

## Milestone 1 — OpenAI and Azure Realtime transcription

Status: implemented and merged into `main`.

- Use `gpt-realtime-whisper` through either the direct OpenAI Realtime API or Azure OpenAI's GA Realtime endpoint.
- Stream 24 kHz mono PCM to `gpt-realtime-whisper` over WebSocket.
- Maintain independent sessions for microphone and system audio.
- Keep credentials in the Electron main-process transport; never place them in the WebSocket URL or transcript events.
- Use bounded pre-connect and socket backpressure buffers.
- Detect local speech boundaries and cap long utterances.
- Display partial and finalized transcripts with speaker labels.
- Deduplicate final events by Realtime item ID.
- Close sessions on stop, settings changes, renderer shutdown, and the emergency quit path.
- Fall back once to OpenAI/Gemini batch transcription when Realtime fails; do not reconnect in a loop.
- Allow mode, language hint, latency setting, and fallback model configuration.

### Milestone 1 acceptance criteria

- Realtime setup sends the documented transcription-session shape.
- Audio is 24 kHz PCM16 mono.
- API keys are sent only in provider-specific connection headers (`Authorization` for OpenAI, `api-key` for Azure), never in URLs or renderer IPC.
- Mic and system-audio transcripts retain their channel labels.
- Partial and final events render without HTML injection.
- Queues, partial maps, dedupe sets, transcript history, and batch buffers are bounded.
- Stop and quit close active/connecting sockets.
- A Realtime failure moves the current listening session to batch mode exactly once.
- Unit, protocol, UI wiring, syntax, package, and runtime smoke checks pass.

## Milestone 2 — Production audio quality

Status: core transport and observability implemented; measured accuracy evaluation remains.

- Implemented: replace deprecated `ScriptProcessorNode` capture with an `AudioWorklet`.
- Implemented: replace the fixed RMS gate with an adaptive noise-floor VAD with hysteresis, minimum speech duration, configurable sensitivity, and bounded utterances. Silero remains an optional future accuracy evaluation rather than a runtime dependency.
- Implemented: add a bounded preroll buffer so quiet consonants are not clipped.
- Implemented: add configurable silence duration and sensitivity presets.
- Implemented: capture reports the actual `AudioContext` rate and performs deterministic streaming resampling to 24 kHz before PCM16 encoding.
- Implemented: Settings includes a five-second end-to-end live microphone diagnostic that requires a real transcript and returns sanitized endpoint/deployment/audio telemetry without persisting audio.
- Implemented: microphone and system capture can be enabled independently; only enabled Realtime channels open provider sessions.
- Implemented: repeatable VAD accuracy evaluation harness (`npm run eval:vad`) that synthesizes a deterministic test set — accents via macOS `say`, synthetic noise at fixed SNR, cross-talk overlays, technical terms, numbers, long pauses, and empty turns — and reports empty-turn rate, false negatives, boundary error, truncation, and optional WER via a configured whisper adapter.
- Remaining: run the evaluation set against real meeting recordings and add empty-turn/truncation/WER targets from the results.
- Implemented: track first-partial and final latency. Empty-turn, truncation-rate, and word-error-rate evaluation remains.
- Implemented: add per-channel connection/audio health, level meters, session duration, cost warning, session limit, and explicit retry.

## Milestone 3 — Automatic assistance

Status: core implemented on `main` (opt-in Auto-assist).

- Implemented: question detection runs only on finalized **Them** turns, never partials.
- Implemented: merged speaker turns are grouped before classification.
- Implemented: repeated questions are deduplicated per turn and across automatic answers.
- Implemented: automatic answers are opt-in (`autoAnswer` setting, off by default) with a 60-second cooldown, duplicate suppression, a local confidence threshold, and busy/capture gating in `src/auto-assist.js`.
- Implemented: "Draft answer" answers the detected question directly through the `auto-assist` feature mode.
- Implemented: auto-assist includes session context, resume, job description, and enabled documents through the shared personal-context path.
- Implemented: cooldown and confidence threshold are configurable in Settings (seconds and percent).
- Remaining: measure answer usefulness on real meetings.

## Response provider coverage

OpenAI-compatible response routes: DeepSeek, Groq, OpenRouter, and local Ollama (keyless, `http://localhost:11434/v1`). All are handled by the single `baseURL` branch in `src/llm.js`; Azure remains separate because it authenticates with an `api-key` header. `src/provider-config.js` is the single source of truth — `tests/provider-consistency.test.js` keeps the renderer, README, and landing page in sync with it.

## Milestone 4 — Additional STT providers

- Azure AI Speech: realtime partials, phrase lists, language detection, and optional diarization.
- ElevenLabs Scribe Realtime: evaluate latency, multilingual accuracy, cost, and multichannel behavior before adding.
- Local transcription: evaluate whisper.cpp or another offline engine for privacy-sensitive sessions.
- Keep provider selection behind one streaming STT interface so the renderer and Auto Assist pipeline do not change.

## Milestone 5 — On-device meeting history

Status: implemented (Phases 3a/3b/3c).

- Implemented: opt-in `transcription.historyEnabled` setting (off by default) exposed as "Save meeting history" in Settings > Listening, with a privacy disclosure.
- Implemented: a finalized session (listening stopped, new session started, or app quit) persists only the final transcript turns to `<userData>/meetings/*.json` with 0600 permissions and atomic writes; raw audio is never stored.
- Implemented: bounded retention (200 records, 5000 turns each), traversal-safe record ids, skip-when-unchanged dedupe, and list/get/delete/clear IPC surfaced through the preload bridge.
- Implemented: structured notes for a saved record via the recap pipeline (`history:recap`), streamed through `history:recap-token`; long meetings require explicit confirmation before multi-request chunking so notes cannot create surprise usage charges.
- Implemented: full-fidelity export of a saved record to txt/md/json (`history:export`) through a save dialog; `src/meeting-notes.js` formats the record with session metadata and all turns (no 500-turn live-transcript truncation).
- Implemented: history browser in the panel dock ("History") with metadata + preview text search, per-meeting detail view (read-only transcript), export/notes/delete controls, and Clear all. `history:list` carries a bounded text preview so search stays local and cheap.

## Milestone 6 — In-session meeting detection

Status: implemented (Phases 4a/4b).

- Implemented: opt-in `transcription.meetingDetection` setting (off by default) exposed as "Detect meetings" in Settings > Listening, with a privacy disclosure.
- Implemented: `src/meeting-detect.js` — a rolling-window detector that classifies a session as a meeting when, inside a 5-minute window, both the Mic (you) and System (them) channels contribute at least 3 finalized turns each, alternate at least 2 times, and the activity spans at least 30 seconds. It consumes only in-memory finalized turns — no background audio watcher, no disk writes, and no AI requests.
- Implemented: the detector feeds on finalized turns during an active listening session only, emits a single `meeting:detected` event on the rising edge, and resets when a new session or app quit clears the transcript.
- Implemented: a saved history record is tagged `meeting: true` when the session was classified as a meeting, and the flag round-trips through `history:list` / `history:get`.
- Implemented: during a live session the renderer shows a subtle "Meeting in progress" pill in the transcript header on `meeting:detected`, and clears it when listening stops or a new session starts.
- Implemented: saved records classified as meetings carry a "Meeting" badge in the history list and detail view, and exported txt/md/json notes use a meeting-aware header ("Volyx Lens meeting" + a detected-as-two-sided-conversation line) while non-meeting sessions stay labeled "session".

## Security and privacy constraints

- No audio capture before the user explicitly starts listening.
- No background meeting watcher in the initial implementation.
- No automatic reconnect or retry loop that can create surprise usage charges.
- No audio persistence; transcript history is written to disk only when the opt-in "Save meeting history" setting is enabled, and records contain final text turns only.
- No secrets in URLs, renderer events, logs, error messages, tests, or repository files.
- Emergency quit stops capture, clears in-memory session data, and closes sockets immediately.

## macOS validation still required

A real Mac with a permitted OpenAI key must verify:

1. Microphone and Screen/System Audio permission behavior.
2. 24 kHz microphone and loopback capture.
3. First partial and final transcript latency.
4. Separate **You** and **Them** labels.
5. Stop, restart, settings-change, network-loss, and emergency-quit behavior.
6. Fallback when Realtime access is denied.
7. A 30–60 minute session for memory, cost, and transcript-order stability.
