# Speech recognition benchmark

The speech benchmark runs the same deterministic audio corpus through a selected local GGUF model and records accuracy, latency, throughput, memory, and completeness.

## Run

```bash
# Generate the shared VAD/ASR corpus once.
npm run eval:vad -- --regenerate

# Benchmark an installed model.
npm run eval:speech -- --model=parakeet-unified-en --language=en

# Save a machine-readable report.
npm run eval:speech -- \
  --model=parakeet-unified-en \
  --language=en \
  --check \
  --json=node_modules/.cache/speech-benchmark/parakeet.json
```

Models are not downloaded implicitly. Install one from Settings or with the registry's `prepareModel()` API first.

Evaluate the neural detector against the same corpus:

```bash
npm run eval:vad -- --report --neural
```

This requires the pinned Silero detector to be installed. RMS evaluation still runs alongside it, so the fallback remains covered.

## Corpus

The corpus is defined in `scripts/vad-accuracy-eval.js` and generated into `node_modules/.cache/vad-eval/`. It includes:

- six English accents;
- technical terms and model/deployment names;
- numbers, times, versions, and percentages;
- 4-second and 8-second pauses;
- cross-talk;
- white and pink noise;
- a long utterance;
- silence and near-threshold noise fixtures.

Cross-talk is excluded from WER by default because it has no single unambiguous reference transcript. Use `--include-overlays` to measure it separately.

## Metrics

| Metric | Meaning |
| --- | --- |
| WER | Word error rate against the fixture reference |
| Cold start | Model verification, load, and warm-up time |
| Latency | Wall-clock time per clip |
| Inference time | Native runtime duration when reported |
| RTF | Inference time divided by audio duration |
| Child RSS | Resident memory of the native worker |
| Child CPU | Process CPU percentage reported by the OS |
| Empty rate | Clips returning no transcript |
| Completeness | Clips returning a non-empty transcript |

On macOS, GPU utilization and driver memory are sampled from `ioreg`'s `AGXAccelerator` statistics, and thermal pressure is read from `pmset -g therm`. These are system-wide driver snapshots, not per-process VRAM or energy measurements. Other platforms report `null`/unavailable. RSS and CPU sampling use POSIX `ps`; Windows reports those metrics as unavailable rather than zero. Pass `--no-gpu-metrics` to skip the optional macOS sampler. WER is a corpus-level accuracy signal, not a guarantee for every accent, microphone, or acoustic environment.

## Runtime and hardware policy

The native worker is built for macOS x64/arm64, Windows x64, and Linux x64/arm64. Release packages cover those same targets. CPU builds use a portable instruction-set floor and do not link system BLAS. macOS builds include Metal; Windows/Linux Vulkan is an opt-in source build and requires the platform loader and driver.

`hardware-info` reports registered devices and compiled backend availability. Settings exposes Automatic, CPU only, and GPU when available. A failed GPU load or batch warm-up/inference OOM retries once on CPU; that fallback is retained for the loaded model and shown in Settings. The measured baseline below is arm64 macOS with Metal and must not be treated as a Windows/Linux CPU benchmark.

## Measured Apple Silicon baseline

Measured 2026-11-26 on the local arm64 macOS development machine with Parakeet Unified English Q8_0 and Silero VAD v6.2:

| Metric | Result |
| --- | --- |
| Speech fixtures | 19 non-overlay clips |
| Literal mean WER | 16.9% |
| Median inference latency | 76–87 ms across sequential runs |
| Mean RTF | 0.013–0.031 |
| Completeness | 100% |
| Peak child RSS | 192–204 MB |
| Cold start | 0.56–5.27 s; the high end occurred during concurrent runs |
| Silero false positives | 0% across 3 empty/noise fixtures |
| Silero false negatives | 0% across 20 speech/noise/cross-talk fixtures |
| Silero mean latency | ~3 ms per clip |
| Metal device utilization | 86.4% mean, 96.0% maximum across post-inference snapshots |
| Metal driver system memory | ~1,455 MiB peak system-wide snapshot; not per-process VRAM |
| Thermal pressure | Nominal |

### Metal versus portable CPU

Three CPU runs and repeated Auto/Metal runs used the same 19 fixtures on the M2 Pro:

| Backend | Median latency | Mean RTF | Peak worker RSS | Mean child CPU |
| --- | ---: | ---: | ---: | ---: |
| Auto / Metal | 76 ms | 0.013 | 200,864 KB (~196 MiB) | 17.4% |
| CPU only | 134 ms | 0.024 | 1,207,216 KB (~1.15 GiB) | 90.5% |

On this corpus Metal reduced median latency by about **1.8×** and peak worker RSS by about **6×** versus the portable CPU path. Auto therefore correctly prefers Metal on Apple Silicon; CPU remains the compatibility and OOM fallback.

A 40-iteration sustained Metal run on the long-utterance fixture remained thermally nominal. Worker RSS stabilized around **191–193 MiB** after warm-up, with inference typically **220–244 ms** and one 304 ms outlier; no sustained memory growth or throttling was observed.

Literal WER treats equivalent formatting as different words. For example, Parakeet returned `$42,310` for “forty two thousand three hundred and ten dollars” and `2.1.7` for “two point one point seven.” Raw references and hypotheses are retained in the JSON report so scoring can be tightened without hiding the model output.

Segmented batch transcription was compared with whole-clip transcription on the pause, long-utterance, accent, and technical fixtures. WER was unchanged; padding merged adjacent Silero ranges where needed, and the 4-second/8-second pause fixtures produced two ordered utterances instead of one clip.

## Acceptance policy

Do not choose defaults from a single run. Compare at least three sequential runs per model and hardware target, report the median and worst case, and keep the JSON reports with release notes. Use `--backend=auto|cpu|gpu` for backend comparisons and `--no-gpu-metrics` when the macOS sampler is not wanted. A model is not production-default material until it has acceptable WER, completeness, cold start, RTF, and sustained memory on the minimum supported hardware.

`--check` currently enforces mean WER ≤ 25%, completeness ≥ 95%, empty rate ≤ 5%, median latency ≤ 2,000 ms, and mean RTF ≤ 0.5. Override them with `--thresholds=path/to/thresholds.json` when evaluating slower hardware or a different model class.
