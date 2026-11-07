# Volyx Lens Architecture

Volyx Lens is an Electron application with a strict split between a privileged main process and a sandboxed renderer. This document describes the process model, the preload bridge, provider routing, and the capture pipelines.

## Process model

```
┌─────────────────────────────────────────────────────────┐
│  Main process (Node.js, no sandbox)                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  Capture      │  │  Provider    │  │  Credential  │  │
│  │  controllers  │  │  router      │  │  vault       │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────────┘  │
│         │                  │                             │
│  ┌──────┴──────────────────┴──────────────────────────┐  │
│  │  IPC handlers (ipcMain)                             │  │
│  └────────────────────────┬───────────────────────────┘  │
└───────────────────────────┼──────────────────────────────┘
                            │ contextBridge (preload.js)
┌───────────────────────────┼──────────────────────────────┐
│  Renderer process (Chromium, sandboxed)                  │
│  ┌────────────────────────┴───────────────────────────┐  │
│  │  window.volyxLens (preload bridge surface)         │  │
│  └────────────────────────┬───────────────────────────┘  │
│         │                  │                             │
│  ┌──────┴───────┐  ┌──────┴───────┐                     │
│  │  UI state    │  │  Audio worklet│                     │
│  │  (React-free)│  │  (24 kHz PCM) │                     │
│  └──────────────┘  └──────────────┘                     │
└─────────────────────────────────────────────────────────┘
```

- **Main process** (`main.js`): owns all native resources — the BrowserWindow, capture pipelines, provider clients, credential storage, and OS integrations. It never executes renderer code.
- **Renderer process** (`renderer/`): a sandboxed Chromium context with `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`. It has no direct access to Node.js, the filesystem, or native APIs.
- **Deep links** (`src/deep-link.js`): the parser accepts only `volyxlens://updates` (or `update`), `volyxlens://release`, `volyxlens://settings` with an optional allowlisted `pane`, and `volyxlens://open`. macOS delivers a link through `open-url`, Windows and Linux through argv on `second-instance` and at launch, and `main.js` holds the newest link in a single slot until `app:renderer-ready` so a cold start still routes it.

## Preload bridge surface

The preload script (`preload.js`) is the only sanctioned channel between the two processes. It uses `contextBridge.exposeInMainWorld('volyxLens', { ... })` to expose a narrow, audited API surface:

| Category | Methods |
|---|---|
| Settings | `settingsGet`, `settingsSet` |
| Credentials | `clearCredential` |
| Personal context | `personalContextGet`, `personalContextImport`, `personalContextRemove`, `personalContextSetEnabled` |
| Conversation | `ask`, `cancelResponse` |
| Capture | `captureToggle`, `captureStop`, `captureState`, `setDisplayCaptureIntent` |
| Session | `newSession` |
| Task context | `taskContextGet`, `taskContextList`, `taskContextCapture`, `taskContextUndo`, `taskContextRemove`, `taskContextPin`, `taskContextClear` |
| Transcript | `transcriptGet`, `recapPlan`, `transcriptCopy`, `transcriptCopyTurn`, `transcriptClear`, `transcriptExport` |
| History | `historyList`, `historyLimits`, `historyGet`, `historyDelete`, `historyDeleteMany`, `historyUndoDelete`, `historyRestoreTrash`, `historyClear`, `historyExport`, `historyBackupAll`, `historyRestoreAll`, `historyRecap`, `historyClean`, `historyParticipant`, `historyDiscardCleaned` |
| Recovery | `recoveryGet`, `recoveryRestore`, `recoveryDiscard` |
| Diagnostics | `diagnosticsGet`, `diagnosticsCopy` |
| Clipboard | `copyText` |
| Shortcuts | `shortcutsGet`, `shortcutsRetry`, `shortcutsSet`, `shortcutsReset`, `shortcutsValidate` |
| Updates | `updateGetState`, `updateCheck`, `updateDownload`, `updateInstall`, `updateOpenReleases` |
| Provider testing | `testResponseProvider`, `providerCapability`, `testRealtime`, `startLiveTranscriptionTest`, `finishLiveTranscriptionTest`, `liveTranscriptionPcm`, `retryRealtime` |
| Permissions | `requestPermission`, `permissionStatus`, `openPermissionSettings` |
| Slide tracking | `slideTrackingClear`, `slideTrackingReview` |
| Context menu | `showContextMenu` |
| Audio streaming | `micPcm`, `systemPcm` |
| Window | `setIgnoreMouse`, `setWindowCollapsed`, `setModalState`, `openPane` |
| Lifecycle | `rendererReady`, `quit`, `relaunch`, `log` |
| Events | `on(channel, cb)`, a filtered allowlist of 32 IPC channels, including `update:open` and `deeplink:open` |

The bridge exposes 85 members in total: 82 methods plus the `platform`, `audioConfig`, and `initialAccentTheme` values; the table groups the methods by purpose. Credentials are written through `settingsSet` (`apiKeyUpdates`), not a separate call.

The `on()` listener uses a strict allowlist of event channels. Any channel not in the allowlist is silently ignored, preventing the renderer from subscribing to unintended IPC traffic.

## Settings and appearance

Settings live in `src/store.js` and reach the renderer through `settingsGet` / `settingsSet`. `appearance.theme` is a closed enum (`indigo`, `sage`, `ember`) owned by `src/appearance-themes.js`; `load()` normalises a missing, corrupt, or unknown value to `indigo` after the defaults merge, and `sanitizeSettingsPatch` accepts only the three ids. No arbitrary theme name or CSS can be written through IPC.

The accent is applied by a data attribute on `<html>`, which every theme block in `renderer/styles.css` keys off. To avoid a first-frame flash of Indigo on a Sage or Ember install, the main process reads the stored id before creating the window and appends `--volyx-accent=<id>` to `additionalArguments`. The sandboxed preload re-validates that argument and exposes only the resulting string as `initialAccentTheme`; `renderer/theme-boot.js` runs in the head before the stylesheet, reads the argument (or the non-sensitive `volyx.accentTheme` paint hint used after a renderer-crash reload), and sets the attribute. Nothing blocks on a synchronous IPC call. Once `settingsGet` resolves, the renderer reconciles the attribute from the store, which is the authority, and writes the hint for the next reload.

Changing the radio in **Settings → Appearance** applies the attribute immediately, calls `settingsSet({ appearance: { theme } })`, and restores the previous radio, attribute, and status message if the save is rejected.

## Provider routing

Provider routing lives entirely in the main process. The renderer sends an `ask` or `transcription:*` IPC message; the main process resolves the configured provider and streams results back.

### Response routing (`src/response-router.js`)

```
createResponseRoute(settings)
  ├── primary   = createLLM({ provider: settings.provider })
  └── fallback  = createLLM({ provider: settings.fallbackProvider })  // optional

chooseInitialProvider(route, { requiresVision })
  ├── primary ready and compatible? → use primary
  ├── fallback ready and compatible? → use fallback, mark usedFallback
  └── neither → return `{ llm: null, reason: 'No compatible provider is configured.' }`

streamWithFallback({ llm, fallback, params, onFallback })
  ├── try primary.stream()
  ├── on error: if compatible fallback exists and no tokens emitted yet → fallback.stream()
  └── abort signal preserved across fallback
```

### Response providers (`src/llm.js`, `src/provider-config.js`)

12 response providers, each identified by a stable key:

| Key | SDK / path | Notes |
|---|---|---|
| `openai` | OpenAI SDK | OpenAI-compatible; also handles transcription |
| `anthropic` | Anthropic SDK | Messages API; no transcription |
| `gemini` | `@google/genai` | Also handles batch transcription |
| `azure` | OpenAI SDK (`api-key` header) | Azure Foundry; separate from Azure AI Speech |
| `deepseek` | OpenAI SDK (`baseURL`) | Vision on `deepseek-flash` only |
| `groq` | OpenAI SDK (`baseURL`) | No vision |
| `nvidia` | OpenAI SDK (`baseURL`) | `maxImagesPerRequest: 1` |
| `openrouter` | OpenAI SDK (`baseURL`) | Vision-capable |
| `ollama` | OpenAI SDK (`baseURL`) | Keyless, local |
| `opencode` | OpenAI SDK (`baseURL`) | Keyless, local; default `http://127.0.0.1:4096/v1` |
| `opencodeGo` | OpenAI SDK (`baseURL` + `x-opencode-session`) | Hosted Go subscription; default `https://opencode.ai/inference/go/openai/v1`; per-model vision allow list; 2048/4096 output floor for reasoning |
| `custom` | OpenAI SDK (`baseURL`) | User-supplied endpoint (required), key optional |

`provider-config.js` is the single source of truth for provider metadata (labels, models, vision support, base URLs). `src/llm.js` implements the streaming adapters.

### Transcription routing (`src/realtime-stt.js`, `src/stt.js`)

Realtime transcription runs on four providers. Batch transcription is a fallback chain plus optional local Whisper.

| Key | Mode | Notes |
|---|---|---|
| `openai` | Realtime | `gpt-realtime-whisper` model |
| `azure` | Realtime | Azure Realtime endpoint |
| `deepgram` | Realtime | Nova-3 streaming |
| `azureSpeech` | Realtime | Azure AI Speech (region-based, separate credentials) |
| `gemini` | Batch | Gemini batch transcription |
| `groq` | Batch | Groq Whisper, enabled by a Groq key rather than a separate selector |
| `local Whisper` | Offline batch | whisper.cpp server; bundled on Windows x64 and Linux x64/arm64; disabled by default |

`REALTIME_PROVIDERS` in `provider-config.js` lists the four realtime keys. The batch fallback order lives in `src/stt.js`. Local Whisper is gated by `transcription.offlineEnabled` and needs a `whisper-server` binary. Packaging provisions the pinned whisper.cpp server for Windows x64 and Linux x64/arm64 through `scripts/prepare-whisper-runtime.js`: it downloads the pinned release (v1.9.5, nightly tag `b5454`), verifies the SHA-256 of the archive and of every extracted file, and installs the server plus its shared libraries into `native-bin/` for `electron-builder` to ship. `VOLYX_LENS_SKIP_WHISPER_RUNTIME=1` skips that step. whisper.cpp publishes no macOS server, so a macOS package ships no engine and the toggle stays off there unless `VOLYX_LENS_WHISPER_SIDECAR_BIN` points at one. The Windows build needs the Microsoft Visual C++ 2015-2022 Redistributable at runtime. The model is downloaded into a private cache when one is not present.

## Capture pipelines

Volyx Lens maintains three intentionally separate capture pipelines. Each has its own lifecycle, format, and transport to the main process.

### Screen capture

- **Trigger:** explicit user action (Assist, Solve, Add Task Context).
- **macOS:** `desktopCapturer` + optional Apple Vision OCR (`volyx-lens-vision-ocr` native helper).
- **Windows / Linux:** `desktopCapturer`; no local OCR (falls back to recency/pinned ranking).
- **Format:** compressed JPEG/PNG data URL, SHA-256 deduplicated, bounded in-memory store (max 39 images per request, including the current screen).
- **Transport:** captured in the main process through `desktopCapturer`; the `ask` payload carries only mode, text, and confirmation flags. Main attaches the selected images after the user asks.

### Microphone (You channel)

- **Trigger:** user toggles capture or starts a session.
- **Format:** raw PCM, resampled to 24 kHz mono in the audio worklet.
- **Transport:** renderer sends `mic:pcm` IPC messages with `ArrayBuffer` payloads. The main process feeds PCM to the active realtime transcription provider.
- **Processing:** realtime provider streams partial → confirmed transcript turns. Turns are tagged as **You**.

### System audio (Them channel)

- **Trigger:** user toggles capture (independent of microphone).
- **macOS:** bundled ScreenCaptureKit helper (`volyx-lens-system-audio`) — captures system audio without a loopback cable.
- **Windows:** Chromium system-audio loopback (no extra permission needed).
- **Linux:** PulseAudio/PipeWire monitor source via `pactl` / `parec` (best-effort; fails gracefully if unavailable).
- **Format:** raw PCM, kept separate from the microphone channel.
- **Transport:** renderer sends `system:pcm` IPC messages. The main process feeds PCM to the same realtime provider but tags turns as **Them**.

### Capture exclusion

- **macOS:** `win.setContentProtection(true)` maps to `NSWindowSharingNone`. Many capture tools honor it; ScreenCaptureKit-based recorders may not.
- **Windows:** the same call maps to `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`. Windows 10 2004 and later remove the window from capture; older builds capture a black window.
- **Linux:** no capture-exclusion API. The overlay can appear in screen shares.

## Request lifecycle

1. User triggers an action (shortcut, button, or `/command`).
2. Renderer sends an `ask` IPC message with mode, text, and confirmation flags. The main process captures the screen, selects transcript turns and personal-context excerpts, and applies the budgets.
3. Main process runs local controls: permission checks, memory budgets, deduplication, image cap, confirmation for expensive requests.
4. `createResponseRoute` builds primary + fallback LLM instances.
5. `chooseInitialProvider` selects the best compatible provider.
6. `streamWithFallback` streams tokens back to the renderer via `llm:token` IPC.
7. On completion, the main process normalizes the finished answer before it sends `llm:done` (`src/answer-normalize.js`): em and en dashes become commas, a dash between digits becomes a hyphen, and curly quotes become straight ones, while fenced code blocks are copied through byte for byte.
8. Renderer displays the streaming answer and re-renders the normalized text carried by `llm:done`; on error, `llm:error` fires with a sanitized message.

## On-device state

- `src/meeting-store.js` keeps at most 200 records, writes atomically, and holds deleted records for 30 days before pruning. A restore that does not fit is refused rather than pruned.
- `src/meeting-recovery.js` writes a 0600 checkpoint of an in-progress transcript and offers restore or discard after an unexpected exit.
- `src/meeting-backup.js` exports one file per record plus an index; import validates each record and never overwrites an existing id.
- `src/meeting-notes.js` and `src/transcript-cleanup.js` run one model job at a time over saved meetings, require confirmation for multi-request work, and store the source hash with generated notes.
- `src/slide-tracking.js` samples the screen while listening and keeps at most 20 previews (8 MB) in memory; it never calls a provider.

## Update path

A build is described by two separate capabilities. `installable` means it can download and install in place, which requires a signed release build. `supported` means it can check at all, which is true for any packaged build on a supported platform: an unsigned DMG or installer checks through `src/release-check.js` and `src/release-check-client.js` against the public GitHub Releases API, reports `available` with `installable: false`, and the renderer's action opens the release page instead of downloading. The scheduler and the notification path only require `supported`.

`src/update-manager.js` uses `electron-updater` with per-platform publish metadata (`latest.yml` for Windows; on Linux the name is the channel plus the platform suffix, `latest-x64-linux.yml` and `latest-arm64-linux-arm64.yml`, composed by `src/update-metadata.js` so the workflow publishes the name the client requests). Windows publishes that metadata only for a signed installer, so the unsigned installer ships with no `latest.yml` and no auto-update channel, while the tag-triggered Linux release publishes it for the unsigned AppImages and they do update in place. macOS auto-update is only published for signed builds; the current unsigned DMGs ship without updater metadata.

Before a release job uploads, `scripts/verify-release-assets.js` checks the file set against `src/release-assets.js`: no duplicate installer, AppImage, or macOS archive for an architecture, a checksum beside each Windows and Linux artifact, and a `latest*.yml` name that matches the channel the client requests (or no metadata where the build intentionally publishes none). Five workflows run it before upload.

### Update notifications

`src/update-scheduler.js` polls `updateManager.check()` once shortly after launch and then every six hours (defaults in that module; timers are injected so the cadence is unit-tested). The relative timer measures awake time, so `main.js` calls `updateScheduler.onResume()` on `powerMonitor`'s `resume`; when the six-hour interval elapsed in wall time while the machine slept, the scheduler arms a short catch-up check instead of waiting out a fresh interval. Polling is armed only while `settings.notifications.updates` is true **and** the build reports `supported: true`; a build that can only point at the release page still qualifies, because knowing a release exists is useful on its own. `main.js` calls `updateScheduler.sync()` whenever settings change and `stop()` during `shutdownAll`. `update-manager` records `lastCheckedAt` when a check finishes, including a failed one, and the Updates pane shows it.

`src/update-notifications.js` is pure: given the previous state, the next state, and whether the preference is on, it returns an OS notification for the `available`, `unavailable`, and `downloaded` edges or `null`. Each notice carries a `key` (`available:<version>`), and `main.js` persists the keys it has announced through `store.recordNotifiedUpdateKey`, so a relaunch does not announce the same version again; a periodic check re-enters `available` every cycle, so the transition alone would notify every six hours. `src/notification-policy.js` decides delivery: a banner is silent, a locked screen defers the notice until unlock, and listening or a focused window drops it. Clicking a notification focuses the window, sends `update:open`, and the renderer opens Settings → Updates.
