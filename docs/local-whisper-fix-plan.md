# Local Whisper hardening plan

**Status:** implemented and verified  
**Branch:** `fix/local-whisper-hardening`  
**Reviewed commit:** `a9f715f`

## Verdict

Local Whisper is structurally sound but not shippable. The packaged `whisper-server` v1.9.5 rejects the `--temp 0` startup argument, so every normal local transcription session fails before the health check. The unit suite is green because it never starts the real binary.

## Batch 1: sidecar startup and lifecycle

**Status:** fixed. The real pinned v1.9.5 binary now starts with `buildServerArgs`, answers `/health`, and returns JSON from `/inference`.

**Files:** `src/whisper-sidecar.js`, `tests/whisper-sidecar.test.js`, `tests/whisper-download.test.js`

1. Remove the unsupported `--temp 0` argument. Keep deterministic inference by sending `temperature=0.0` in the multipart body instead.
2. Add a small exported `buildServerArgs` helper and test it. The argument list is now a contract that can be checked without spawning.
3. Allocate the HTTP port with a TCP server, not a UDP socket.
4. Raise the sidecar startup timeout to 120 seconds so large-v3 can load on a slow disk.
5. Pass the model download progress callback through `WhisperSidecar.start()`.
6. Make model download abortable with an `AbortSignal`. `stop()` aborts a download and invalidates an in-flight start so no child is spawned after cancellation.
7. Abort the active inference request on `stop()` rather than leaving a fetch running for two minutes.
8. Use the pinned runtime version from `whisper-runtime-manifest` instead of the stale hard-coded `v1.9.2`.
9. Update the model descriptions in `MODEL_SPECS` so quantized multilingual files are not called English-only.

**Acceptance**

- A fake-spawn test captures the real argument list and proves no unsupported flag is present.
- A process-level probe runs the pinned v1.9.5 binary with the generated args, reaches `/health`, and gets a JSON response from `/inference`.
- `node --test tests/whisper-sidecar.test.js tests/whisper-download.test.js` passes.

## Batch 2: model picker truth

**Status:** fixed. The selector offers 16 published models; unavailable options are removed and int8 labels match the multilingual files.

**Files:** `renderer/index.html`, `tests/offline-capability.test.js`, new UI/catalog test if needed

1. Remove `large-v3.en` and `distil-large-v3` from the model selector. Both are explicitly unavailable in `src/whisper-models.js`.
2. Correct the int8 descriptions. `tiny.int8`, `base.int8`, `small.int8`, `medium.int8`, and `large-v3.int8` point at multilingual quantized files.
3. Add a test that parses the selector options and proves every offered model has a published file.
4. Keep `base.en` as the default; it is the best speed/quality choice for English.

**Acceptance**

- No selector option can hit `unavailableReason`.
- The UI labels match the files in `src/whisper-models.js`.
- `node --test tests/offline-capability.test.js` passes.

## Batch 3: independent review and gate

**Status:** fixed after one independent reviewer found and we repaired two P1s: a child that exits during startup now rejects promptly with its exit code, and concurrent `start()` calls share one child. A second reviewer found no P0/P1 security or privacy issues.

1. Read the full diff.
2. Run the focused Whisper tests and the full suite.
3. Run a real pinned-runtime smoke test on the host architecture.
4. Run syntax, secret scan, and the Electron UI harnesses if `renderer/` changed.
5. Record any remaining P2s honestly.
