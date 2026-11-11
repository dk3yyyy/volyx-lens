# Volyx Lens changelog

## 11 November 2026

### v0.8.9

This release fixes local Whisper transcription.

- The packaged whisper-server now starts with the arguments supported by the pinned v1.9.5 runtime. The unsupported `--temp` flag is gone; deterministic decoding uses `temperature=0.0` in the inference request.
- The local server uses a TCP-allocated loopback port and a 120-second startup budget for large models.
- Model downloads are abortable and clean up partial files. Progress is forwarded to the caller.
- Stopping cancels a model download, startup, or active inference request, and a stopped startup cannot spawn a server later.
- A child that exits during startup now rejects immediately with its exit code and stderr.
- Concurrent starts share one local server process.
- The model picker offers only published models. Unavailable English-only and distilled options are removed, and multilingual quantized labels are corrected.
- The runtime directory follows the pinned v1.9.5 manifest instead of the stale v1.9.2 path.

The full suite passes. The local runtime was exercised with the pinned v1.9.5 binary, a verified model, `/health`, and `/inference`. A live microphone test through the packaged app remains recommended.
