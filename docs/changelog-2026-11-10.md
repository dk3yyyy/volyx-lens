# Volyx Lens changelog

## 10 November 2026

### v0.8.6

This release hardens Deepgram realtime speech-to-text.

- Stop and close wait for the final result before closing the socket, so the last utterance survives a normal stop.
- `from_finalize` ends an utterance even when `speech_final` is absent, and a promoted `is_final` segment is emitted once.
- Empty endpoint frames no longer merge two utterances. Duplicate final frames are ignored.
- Server `Error` and `ConfigureFailure` frames are reported without exposing the API key. A rejected configuration no longer kills the live session.
- Pre-connect audio replay stays in order and is retried instead of being stranded.
- An unexpected close clears the dead channel and leaves the batch fallback to take over.
- Connection creation is covered by the timeout, and cancellation cannot create an unhandled rejection.
- Auto and the default empty setting become `language=multi` on supported Deepgram models. Explicit tags such as `zh-HK` preserve their casing.
- Rate-limit errors are classified before the generic token branch.
- A final that misses the drain becomes one `realtime-drain-timeout` gap row.
- The Test Connection diagnostic exercises Auto with `multi`.

The full test suite passes. The Deepgram tests use a fake SDK and a local fake socket; a live account smoke test is still recommended before relying on a production key.

Known limits:

- Free-form Deepgram model IDs are not pre-validated because custom and fine-tuned model IDs are legitimate.
- Stopping during the initial connection discards the bounded pre-connect PCM. The connect window is capped at 10 seconds.
