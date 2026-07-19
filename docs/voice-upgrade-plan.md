# Voice upgrade plan

## Goal

Turn Volyx Lens's fixed 3.5-second upload loop into a low-latency, provider-neutral transcription pipeline that preserves separate **You** and **Them** channels and can later support automatic question detection.

## Milestone 1 — OpenAI and Azure Realtime transcription

Status: implemented on `feat/azure-foundry-deepseek`.

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
- Remaining: build a repeatable evaluation set covering accents, noise, cross-talk, technical terms, numbers, and long pauses.
- Implemented: track first-partial and final latency. Empty-turn, truncation-rate, and word-error-rate evaluation remains.
- Implemented: add per-channel connection/audio health, level meters, session duration, cost warning, session limit, and explicit retry.

## Milestone 3 — Automatic assistance

- Detect likely questions only from finalized **Them** turns.
- Merge corrections and adjacent transcript fragments before classification.
- Deduplicate repeated questions.
- Add cooldown and confidence thresholds.
- Default to manual approval; make automatic answer generation opt-in.
- Never generate from a partial transcript when a final turn is pending.
- Include session context, resume, job description, and selected documents.

## Milestone 4 — Additional STT providers

- Azure AI Speech: realtime partials, phrase lists, language detection, and optional diarization.
- ElevenLabs Scribe Realtime: evaluate latency, multilingual accuracy, cost, and multichannel behavior before adding.
- Local transcription: evaluate whisper.cpp or another offline engine for privacy-sensitive sessions.
- Keep provider selection behind one streaming STT interface so the renderer and Auto Assist pipeline do not change.

## Security and privacy constraints

- No audio capture before the user explicitly starts listening.
- No background meeting watcher in the initial implementation.
- No automatic reconnect or retry loop that can create surprise usage charges.
- No transcript or audio persistence unless a future session-history feature is explicitly enabled.
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
