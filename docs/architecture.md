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
| History | `historyList`, `historyGet`, `historyDelete`, `historyClear`, `historyExport`, `historyRecap` |
| Diagnostics | `diagnosticsGet`, `diagnosticsCopy` |
| Shortcuts | `shortcutsGet`, `shortcutsRetry` |
| Updates | `updateGetState`, `updateCheck`, `updateDownload`, `updateInstall` |
| Provider testing | `testResponseProvider`, `testRealtime`, `startLiveTranscriptionTest`, `finishLiveTranscriptionTest`, `liveTranscriptionPcm`, `retryRealtime` |
| Permissions | `requestPermission`, `permissionStatus` |
| Audio streaming | `micPcm`, `systemPcm` |
| Window | `setIgnoreMouse`, `setWindowCollapsed`, `setModalState`, `openPane` |
| Lifecycle | `rendererReady`, `quit`, `relaunch`, `log` |
| Events | `on(channel, cb)` — filtered allowlist of 30 IPC channels |

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
  └── neither → return primary with empty reason (caller shows config error)

streamWithFallback({ llm, fallback, params, onFallback })
  ├── try primary.stream()
  ├── on error: if compatible fallback exists and no tokens emitted yet → fallback.stream()
  └── abort signal preserved across fallback
```

### Response providers (`src/llm.js`, `src/provider-config.js`)

9 response providers, each identified by a stable key:

| Key | SDK / path | Notes |
|---|---|---|
| `openai` | OpenAI SDK | OpenAI-compatible; also handles transcription |
| `anthropic` | Anthropic SDK | Messages API; no transcription |
| `gemini` | `@google/genai` | Also handles batch transcription |
| `azure` | OpenAI SDK (`api-key` header) | Azure Foundry; separate from Azure AI Speech |
| `deepseek` | OpenAI SDK (`baseURL`) | No vision |
| `groq` | OpenAI SDK (`baseURL`) | No vision |
| `nvidia` | OpenAI SDK (`baseURL`) | `maxImagesPerRequest: 1` |
| `openrouter` | OpenAI SDK (`baseURL`) | Vision-capable |
| `ollama` | OpenAI SDK (`baseURL`) | Keyless, local |

`provider-config.js` is the single source of truth for provider metadata (labels, models, vision support, base URLs). `src/llm.js` implements the streaming adapters.

### Transcription routing (`src/realtime-stt.js`, `src/stt.js`)

5 transcription providers:

| Key | Mode | Notes |
|---|---|---|
| `openai` | Realtime | `gpt-realtime-whisper` model |
| `azure` | Realtime | Azure Realtime endpoint |
| `deepgram` | Realtime | Nova-3 streaming |
| `azureSpeech` | Realtime | Azure AI Speech (region-based, separate credentials) |
| `local Whisper` | Offline batch | whisper.cpp model download; disabled by default |

`REALTIME_PROVIDERS` in `provider-config.js` lists the four realtime keys. Local Whisper is gated by `transcription.offlineEnabled` and uses either the sidecar path (`VOLYX_LENS_WHISPER_SIDECAR`) or the legacy CLI path (`VOLYX_LENS_WHISPER_CLI` + `VOLYX_LENS_WHISPER_MODEL`).

## Capture pipelines

Volyx Lens maintains three intentionally separate capture pipelines. Each has its own lifecycle, format, and transport to the main process.

### Screen capture

- **Trigger:** explicit user action (Assist, Solve, Add Task Context).
- **macOS:** `desktopCapturer` + optional Apple Vision OCR (`volyx-lens-vision-ocr` native helper).
- **Windows / Linux:** `desktopCapturer`; no local OCR (falls back to recency/pinned ranking).
- **Format:** compressed JPEG/PNG data URL, SHA-256 deduplicated, bounded in-memory store (max 39 saved screens + current).
- **Transport:** renderer → main process via `ask` IPC payload (imageDataUrl / imageDataUrls).

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

- **macOS:** `win.setContentProtection(true)` maps to `NSWindowSharingNone`. The window is excluded from most screen-recording and screen-share tools.
- **Windows:** no OS-level capture-exclusion API. `setContentProtection(true)` is a no-op on Windows; the overlay can appear in screen shares.
- **Linux:** no capture-exclusion API.

## Request lifecycle

1. User triggers an action (shortcut, button, or `/command`).
2. Renderer sends an `ask` IPC message with the selected context (screen images, transcript turns, personal context).
3. Main process runs local controls: permission checks, memory budgets, deduplication, image cap, confirmation for expensive requests.
4. `createResponseRoute` builds primary + fallback LLM instances.
5. `chooseInitialProvider` selects the best compatible provider.
6. `streamWithFallback` streams tokens back to the renderer via `llm:token` IPC.
7. Renderer displays the streaming answer. On completion, `llm:done` fires; on error, `llm:error` fires with a sanitized message.

## Update path

`src/update-manager.js` uses `electron-updater` with per-platform publish metadata (`latest.yml` for Windows, `latest-linux.yml` for Linux, DMG/ZIP for macOS). The macOS updater is published together with signed DMGs; Windows and Linux publish auto-update metadata with the installer/AppImages.
