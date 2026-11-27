# Speaker diarization

Volyx Lens treats **VAD**, **ASR**, and **diarization** as separate subsystems. Diarization is experimental, opt-in, local, and currently analyzes only the **system/Them** capture after Listening stops. It does not rewrite transcript channels or text.

## Model

| Field | Value |
| --- | --- |
| Model | `diar_streaming_sortformer_4spk-v2.1-Q8_0.gguf` |
| Role | `transcribe-cpp-diarize` |
| Repository | `handy-computer/diar_streaming_sortformer_4spk-v2.1-gguf` |
| Revision | `60ebab3ef7cae9869be0abcde13360347e96ba03` |
| Bytes | 139,310,336 |
| SHA-256 | `a5dacdc650790266c7a362e54e6bf51952015487edaa606c4e11632bc32442a9` |
| Input | 16 kHz mono PCM |
| Maximum speakers | 4 |
| License | NVIDIA Open Model License |

The artifact uses the same private, atomic, size/SHA-256-verified store as ASR and VAD models. It is intentionally absent from the transcription-model picker.

## Data flow and privacy

1. When enabled **and** meeting history is on, `src/diarization-session.js` retains only system/Them PCM in memory, bounded to 1–10 minutes.
2. Normal stop drains transcription and saves the transcript.
3. The native worker loads the separate Sortformer model and returns speaker-activity timestamps.
4. `meetingStore.updateDiarization()` appends a validated `diarizationRuns` sidecar to the saved meeting.
5. JavaScript zeroes its retained PCM and WAV buffers; the diarizer is unloaded. Native runtime and allocator copies are released normally but are not guaranteed to be cryptographically scrubbed.

Immediate quit, sleep/lock, and New Session clear retained audio without analysis. Audio is never written to history, recovery, backups, or exports. Existing meetings cannot be diarized later because no audio was saved.

## Identity and timing limits

- `speakerId` is an arrival-order slot within one recording. Labels reset on every run and are **not persistent identities**.
- Transcript `channel: 'you' | 'them'` remains capture-source attribution and is never replaced by a diarization label.
- Sortformer exposes a whole-recording Rust API. Its internal “streaming” cache is not a public live diarization API.
- Transcript-text alignment is not attempted. It requires sample-accurate source offsets and a shared capture clock; wall-clock transcript timestamps are insufficient.
- The public output has no usable confidence (`p` is NaN), so confidence is omitted.
- Overlapping speaker rows are preserved and sorted chronologically for display.

## Stored shape

The sidecar is a bounded array on the meeting record. `src/meeting-store.js` validates every run before it is written, keys runs by `recordingId` (a retry replaces its earlier attempt), keeps at most 20 runs per meeting, and drops malformed entries rather than partially repairing them.

```json
{
  "version": 1,
  "recordingId": "diar-run-1",
  "sourceChannel": "them",
  "status": "ready",
  "modelId": "diar-sortformer-4spk",
  "artifactSha256": "<64 hex characters>",
  "preset": "very_high_latency",
  "sampleRate": 16000,
  "durationMs": 5000,
  "segments": [
    { "speakerId": 1, "t0Ms": 100, "t1Ms": 2000 },
    { "speakerId": 2, "t0Ms": 2500, "t1Ms": 4000 }
  ]
}
```

`status` is `ready`, `failed`, or `unavailable`; non-ready runs carry a short `reason` and no segments. There is no audio field. Segments are sorted chronologically with `speakerId` 1–4 only.

## History and export

The meeting detail pane shows a compact **System speaker activity** timeline beneath the transcript. Every row reads `System Speaker N` with a local mm:ss range, followed by a note that arrival-order labels belong to that one recording. The pane never renames the transcript speakers: turns stay `You`/`Them`, and a saved participant name is never applied to a diarization slot.

JSON export includes the validated `diarizationRuns` array so the timeline can be inspected elsewhere. Markdown, TXT, SRT, and VTT exports stay transcript-only. Backups restore the sidecar because it lives on the record itself.

## Measured Apple Silicon baseline

Measured 2026-11-26 on the local M2 Pro using upstream `samples/sortformer-2spk-mix.wav` (SHA-256 `69d7eb62c8100135a694f33d00c961ed85cae2369a5a504217ac3b1d6a6a7edd`).

| Backend | Preset | Median native latency | Peak worker RSS | Golden segments |
| --- | --- | ---: | ---: | ---: |
| Auto / Metal | very high | 80 ms across 3 runs | 100,624 KB | 5 / 5 |
| CPU | very high | 104–109 ms across 3 runs | 221–229 MB | 5 / 5 |
| CPU | low | 1,155 ms single run | 224 MB | 5 / 5 |

Auto selected Metal. After warm-up Metal was faster and used roughly half the worker RSS of CPU on this fixture. The low-latency preset was substantially slower and is not recommended for post-session analysis.

Reproduce with the pinned local model installed:

```bash
npm run eval:diarization -- \
  --audio=/path/to/sortformer-2spk-mix.wav \
  --backend=auto \
  --repeat=3 \
  --check \
  --json=node_modules/.cache/diarization/apple-silicon-auto.json
```

`--check` accepts only the pinned golden audio and very-high-latency preset, then compares all five speaker segments exactly.

## Next steps

- Add a shared capture clock and source-relative PCM offsets before aligning speaker activity to transcript text.
- Evaluate chunked/long-meeting analysis with explicit duration and memory limits.
- Add realtime diarization only if upstream exposes a persistent incremental DIARIZE API.
