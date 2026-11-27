# Speech runtime completion — VAD and streaming slice (E)

Scope: JS wiring for the Silero VAD gate and native local streaming. The Rust
worker (`native/speech-worker`) and `package.json` are owned by the runtime
slice and are not covered by this note.

## What is wired

- `src/speech-worker.js` speaks the worker command contract exactly:
  `vad-load`, `vad-detect`, `vad-unload`, `stream-start`, `stream-feed`,
  `stream-boundary`, `stream-finish`, `stream-cancel`.
  - Streaming events (`{ event: true, type: 'speech.partial' | 'speech.final' |
    'speech.error' }`) are forwarded on `worker.events`.
  - `streamStart` verifies the pinned artifact, enforces one stream per channel,
    reuses a cached CPU fallback, and rejects a backend change while streams are
    active.
  - VAD loads remain separate from ASR model state and survive neither a worker
    exit nor `stop()`.
- `main.js` routes `resolveTranscriptionMode(...) === 'local-stream'` to
  `createLocalSpeechStreamManager`, with partial/final/state/error callbacks.
  A runtime or startup failure recovers the manager's audio into the batch
  buffers and switches to one-model local batch transcription. Immediate and
  normal teardown stop the local manager before the shared worker.
- `main.js` also applies the neural VAD gate in `flushChannel`; RMS remains the
  fail-safe when the detector is missing or fails. Detector segments are mapped
  with `mapVadSegments` and transcribed as bounded per-range batches.
- `src/local-speech-stream-manager.js` adds the three streaming safety limits:
  - a 10 s per-channel lease (refreshed by audio, a final event, or
    `heartbeat(channel)`) that cancels an idle stream with
    `speech_stream_lease_expired`;
  - a 120 s per-channel undelivered-audio bound that refuses further audio with
    `speech_stream_backlog_exceeded` instead of trimming or dropping it;
  - a 3 s `stream-finish` deadline that cancels the channel with
    `speech_stream_finish_timeout` so Stop cannot hang.
- Renderer settings label streaming-capable models and describe inference
  (streaming or batch) rather than batch only. No diarization UI is included.

## Review fixes preserved

The JS was authored on top of the current base rather than copied from the
integrated draft. R1 (`stat.uid !== 0`), R2 (`windowsHide`), R3 (spawn-failure
cleanup), R4 (load generation guard and stop `++workerGeneration` ordering), R5
(`transcriptEpoch += 1` in the immediate branch), R7 (live model selection read
before `replaceChildren`) and R8 (`anyDownloadActive`) are intact.

## Verification

- `node --check` passes for every touched JS file.
- 21 affected test files: 199 tests, 195 pass, 4 fail.
- Full `node --test`: 1630 tests, 1626 pass, 4 fail. All four failures are the
  same packaging assertions that still expect `streaming: false` in
  `scripts/verify-speech-worker-package.js` and
  `scripts/verify-vision-ocr-package.js`; those scripts are owned by the Rust /
  packaging slice and have not been switched to the streaming self-test yet.
- Native Cargo tests and the packaged-worker verification are not claimed here;
  they depend on the Rust worker slice landing.
