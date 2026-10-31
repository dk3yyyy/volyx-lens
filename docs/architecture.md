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
| Shortcuts | `shortcutsGet`, `shortcutsRetry`, `shortcutsSet`, `shortcutsReset`, `shortcutsValidate` |
| Updates | `updateGetState`, `updateCheck`, `updateDownload`, `updateInstall` |
| Provider testing | `testResponseProvider`, `providerCapability`, `testRealtime`, `startLiveTranscriptionTest`, `finishLiveTranscriptionTest`, `liveTranscriptionPcm`, `retryRealtime` |
| Permissions | `requestPermission`, `permissionStatus`, `openPermissionSettings` |
| Slide tracking | `slideTrackingClear`, `slideTrackingReview` |
| Context menu | `showContextMenu` |
| Audio streaming | `micPcm`, `systemPcm` |
| Window | `setIgnoreMouse`, `setWindowCollapsed`, `setModalState`, `openPane` |
| Lifecycle | `rendererReady`, `quit`, `relaunch`, `log` |
| Events | `on(channel, cb)`, a filtered allowlist of 29 IPC channels |

The bridge exposes 83 members in total; the table groups them by purpose. Credentials are written through `settingsSet` (`apiKeyUpdates`), not a separate call.

The `on()` listener uses a strict allowlist of event channels. Any channel not in the allowlist is silently ignored, preventing the renderer from subscribing to unintended IPC traffic.

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

11 response providers, each identified by a stable key:

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
| `local Whisper` | Offline batch | whisper.cpp server; disabled by default |

`REALTIME_PROVIDERS` in `provider-config.js` lists the four realtime keys. The batch fallback order lives in `src/stt.js`. Local Whisper is gated by `transcription.offlineEnabled`, needs a `whisper-server` binary, and downloads a pinned model into a private cache when one is not present.

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
7. Renderer displays the streaming answer. On completion, `llm:done` fires; on error, `llm:error` fires with a sanitized message.

## On-device state

- `src/meeting-store.js` keeps at most 200 records, writes atomically, and holds deleted records for 30 days before pruning. A restore that does not fit is refused rather than pruned.
- `src/meeting-recovery.js` writes a 0600 checkpoint of an in-progress transcript and offers restore or discard after an unexpected exit.
- `src/meeting-backup.js` exports one file per record plus an index; import validates each record and never overwrites an existing id.
- `src/meeting-notes.js` and `src/transcript-cleanup.js` run one model job at a time over saved meetings, require confirmation for multi-request work, and store the source hash with generated notes.
- `src/slide-tracking.js` samples the screen while listening and keeps at most 20 previews (8 MB) in memory; it never calls a provider.

## Update path

`src/update-manager.js` uses `electron-updater` with per-platform publish metadata (`latest.yml` for Windows, `latest-<arch>-linux.yml` for Linux; the release workflow canonicalizes the Linux metadata name so the updater finds it). Windows and Linux publish auto-update metadata with the installer/AppImages. macOS auto-update is only published for signed builds; the current unsigned DMGs ship without updater metadata.
