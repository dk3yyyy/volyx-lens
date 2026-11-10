# Deepgram realtime STT fix plan

**Status:** implemented and verified  
**Branch:** `fix/deepgram-stt-hardening`  
**Audit source:** `docs/deepgram-stt-audit-2026-11-10.md`

## Batch status

| Batch | Status | Evidence |
|---|---|---|
| 1. Channel lifecycle and data loss | Fixed | 36 channel tests pass; mutation checked by the batch author |
| 2. Configuration and classification | Fixed | Auto is preserved through the renderer and maps to `multi`; rate limits classify ahead of auth |
| 3. Manager and pipeline | Fixed | Drain membership, async close, late-final gap, double-stop tests |
| 4. Verification | Fixed | `npm test` 1361 pass; syntax, secrets, four UI harnesses, and coverage gate pass; model/language pre-validation remains deferred |

Deferred: pre-validating every free-form Deepgram model id would reject legitimate custom and fine-tuned model names. The code now limits `multi` to the models that document it, and leaves unsupported auto requests without a language instead of guessing. Stopping while the socket is still connecting still discards the bounded pre-connect PCM; it cannot be transcribed after the socket is cancelled, and the connect window is capped at 10 seconds.

## Outcome

Make the Deepgram realtime path safe to leave on by default: no transcript loss at Stop, correct multilingual behavior, recoverable transport failures, and regression tests that fail when the behavior is removed.

## Non-negotiables

- Change one behavior per batch, with a test that fails before the fix and passes after it.
- Keep the Deepgram key in the main process. No test fixture may look like a real key.
- Do not change unrelated providers unless a shared helper requires it.
- Every batch ends with `node --test` on the Deepgram and manager suites, plus `npm run check:syntax`.
- The final batch runs the full test suite and records any unrelated failures separately.

## Batch 1: channel lifecycle and data loss

**Status:** fixed in `src/deepgram-realtime.js`.

**Files:** `src/deepgram-realtime.js`, `tests/deepgram-realtime.test.js`, `tests/deepgram-stop.test.js`

**Fixes**

1. **Stop tail loss.**
   - `close()` must flush pending `committed` text before clearing it.
   - `from_finalize` results are a boundary, even when `speech_final` is absent.
   - Do not clear committed state while a final can still arrive.
2. **CloseStream drain.**
   - Make `close()` asynchronous: send `CloseStream`, wait for a final `Results`, `Metadata`, or a bounded drain timeout, then close the socket.
   - The manager already awaits `channel.close()`; keep that contract.
3. **Empty endpoint boundaries.**
   - Process `speech_final` and `UtteranceEnd` before the empty-text return.
4. **Server errors.**
   - Handle `Error` and `ConfigureFailure` frames through `sanitizeDeepgramError`; report once and do not crash the stream.
5. **UtteranceEnd sentinel.**
   - Ignore `last_word_end: -1`.
6. **Duplicate finals.**
   - Key finals by a stable result key and ignore repeats.
7. **Unique turn IDs.**
   - Add a monotonic sequence to `itemId`; stop using the constant `deepgram-<channel>-flush`.
8. **Bounded committed text.**
   - Flush at a maximum utterance size so a stream with no endpoint cannot grow forever.
9. **Pre-connect replay.**
   - Remove only buffers that were sent; retain the unsent tail and its byte count.
10. **Unexpected close state.**
    - Set `opened = false`, clear the dead connection, and let the manager take its existing fallback path.
11. **Cancellation safety.**
    - Attach a catch to the cancellation promise at creation.
    - Put SDK connection creation inside the connection timeout, not only `waitForOpen()`.
12. **Reconnect contract.**
    - If app-level reconnect is not added in this batch, make the permanent-degradation explicit: reset state and let the manager fall back. Do not leave a dead channel looking connected.

**Tests**

- A final arriving after `close()` starts is still emitted.
- `from_finalize` without `speech_final` flushes the pending utterance.
- Empty `speech_final` does not merge two utterances.
- `Error` and `ConfigureFailure` call `onError` once, with no key in the payload.
- `last_word_end: -1` does not flush.
- Duplicate final frame emits once.
- Partial and final have different `itemId`s.
- 12k characters without a boundary flushes instead of growing.
- First replay send failure retains the remaining buffers.
- A close event sets `opened = false` and clears the connection.
- `close()` before the SDK client is constructed does not create an unhandled rejection.
- A never-resolving `listen.v1.connect()` times out.

**Acceptance**

```bash
node --test tests/deepgram-realtime.test.js tests/deepgram-stop.test.js
npm run check:syntax
```

## Batch 2: configuration, classification, and UI truth

**Status:** fixed, except the deferred free-form model validation noted above.

**Files:** `src/deepgram-realtime.js`, `src/realtime-errors.js`, `src/provider-config.js`, `src/store.js`, `renderer/index.html`, `tests/deepgram-realtime.test.js`, `tests/provider-config.test.js`

**Fixes**

1. Map `auto` / `automatic` to `language=multi` for Nova-3. Do not silently send English.
2. Validate the Deepgram model and language before opening the socket:
   - known Nova-3 model ids and known language codes;
   - surface a configuration error in settings instead of a runtime 400.
3. Stop suggesting `yue` as a Deepgram code; label it as a Whisper-only language or remove it from the generic example.
4. Cap keyterms by total whitespace tokens (about 450) as well as 50 entries.
5. Reorder the error classifier: explicit `429` / `rate limit` before the generic `token` match.
6. Preserve language casing instead of lowercasing the whole tag; Deepgram documents canonical tags such as `zh-HK`.

**Tests**

- `auto` and `automatic` produce `language: 'multi'` on Nova-3.
- Explicit languages keep their casing.
- An unsupported model/language is rejected at validation, not at connect.
- A 429 containing “token” classifies as `realtime_rate_limited`.
- 50 long keyterms are trimmed under the token cap.
- The UI no longer promises auto-detection it cannot provide.

**Acceptance**

```bash
node --test tests/deepgram-realtime.test.js tests/provider-config.test.js
npm run check:syntax
```

## Batch 3: manager and pipeline

**Status:** fixed in `src/realtime-stt.js` and `main.js`.

**Files:** `src/realtime-stt.js`, `main.js`, `tests/realtime-stt.test.js`, `tests/transcript-gap.test.js`

**Fixes**

1. Use a stop grace longer than `utterance_end_ms`, or let the channel's close drain own the wait. Do not use a fixed 750 ms timer as the only guarantee.
2. Keep the manager in the draining set until `channel.close()` resolves and the final has been recorded.
3. On channel failure, stop the old manager, emit `transcript:gap` once with a stable reason, and route subsequent PCM to batch.
4. Ensure a late final after stop cannot be recorded twice or after the manager has been discarded.
5. Make settings changes while capturing a clear “restart listening” state; do not tear down the live manager silently.

**Tests**

- A final emitted inside the drain window is recorded before `stop()` resolves.
- A final emitted after the drain timeout produces a gap marker, not a silent drop.
- `onError` switches to batch and emits one gap marker.
- Double `stop()` resolves the same promise and closes each channel once.

**Acceptance**

```bash
node --test tests/realtime-stt.test.js tests/transcript-gap.test.js
npm run check:syntax
```

## Batch 4: verification and handoff

**Status:** full suite, syntax, secret scan, four UI harnesses, and coverage gate are green. The branch has six commits; the PR/handoff text is the remaining step.

**Files:** test files only, plus this plan and the audit report status.

1. Run the full Deepgram-related suite.
2. Run the full repository suite and separate unrelated failures by file.
3. Run `npm run check:syntax`, `npm run security:secrets`, and the relevant UI harnesses if `renderer/` changed.
4. Update this plan with a per-finding status: fixed, deferred, or dismissed with evidence.
5. Write a short handoff in the PR body: what changed, what was exercised, what remains.

## Batch order

1. Batch 1, because transcript loss is the P0.
2. Batch 2, because language and validation are user-visible.
3. Batch 3, because the manager must preserve the new channel contract.
4. Batch 4, because the gate must measure the final tree, not an intermediate one.

Each batch gets its own commit. Do not squash until the review is complete.
