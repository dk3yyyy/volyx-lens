# Contributing to Volyx Lens

Thanks for wanting to contribute. Volyx Lens is a privacy-first macOS context assistant, and outside contributions are what make it a real open-source project.

## Getting started

1. Fork the repository and clone your fork.
2. Install dependencies: `npm ci`
3. Run the checks before you start: `npm test` and `npm run check:syntax`

## Prerequisites

Native build tools are required for some platform-specific features:

- **macOS:** Xcode Command Line Tools (`xcode-select --install`) — required for the native OCR helper (`volyx-lens-vision-ocr`) and the system-audio helper (`volyx-lens-system-audio`).
- **Windows:** [Windows Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (C++ build tools workload) or a full Visual Studio installation — required for native module compilation if you rebuild native dependencies.
- **Linux:** `build-essential`, `libsecret-1-dev`, `libnotify-dev`, and `libgtk-3-dev` (Debian/Ubuntu equivalents) — required for keyring and notification support. The Them channel additionally needs `pulseaudio-utils` (or PipeWire's PulseAudio compatibility) at runtime.

## Testing

Run the full test suite:

```bash
npm test
```

This runs all `tests/*.test.js` files via Node's built-in test runner. To run a single test file:

```bash
node --test tests/provider-config.test.js
```

Other verification checks:

```bash
npm run check:syntax      # Syntax check all shipped JS files
npm run security:secrets  # Scan for accidentally committed secrets
npm audit --audit-level=low
npm run release:check     # Release-readiness checks
```

## Environment variables

| Variable | Effect |
|---|---|
| `VOLYX_LENS_NO_PROTECT` | Disables `setContentProtection(true)` on the overlay window (useful for screen-recording the app itself). |
| `VOLYX_LENS_WHISPER_SIDECAR_BIN` | Absolute path to a pre-built `whisper-server` binary, bypassing the bundled download. |
| `VOLYX_LENS_WHISPER_SIDECAR` | Set to `1` to opt into whisper sidecar mode for offline transcription. |
| `VOLYX_LENS_WHISPER_CLI` | Path to a local whisper CLI executable (legacy offline path). |
| `VOLYX_LENS_WHISPER_MODEL` | Model file path for the local whisper CLI. |
| `VOLYX_LENS_WHISPER_SERVER` | Path to a local whisper server executable (preferred over CLI). |
| `WHISPER_DOWNLOAD_BASE` | Override base URL for downloading whisper models (default: Hugging Face). |
| `WHISPER_BINARY_BASE` | Override base URL for downloading whisper.cpp release binaries. |
| `ELECTRON_RUN_AS_NODE` | **Must not be set.** If set to `1`, Electron boots as plain Node and the app fails. See [Troubleshooting](README.md#troubleshooting). |

## Development workflow

- Branch from `main`: `git checkout -b fix/your-description`
- Keep changes focused. Prefer small, reviewable pull requests over one large change.
- Preserve the privacy boundaries documented in the README. Anything that touches audio, screen, or personal-context data must stay local-first and never phone home.
- Include tests for behavior changes (`npm test` runs the full suite).
- Run `npm test` and `npm run check:syntax` before pushing.
- Open a pull request against `main` and describe what you changed and why.

## Code style

- CommonJS modules (`require`/`module.exports`), strict mode.
- Follow the style of the surrounding code; there is no linter gate beyond the syntax check.
- Do not add comments unless they explain a non-obvious decision.

## Architecture

For a detailed walkthrough of the main/renderer process split, preload bridge surface, provider routing, and capture pipelines, see [docs/architecture.md](docs/architecture.md).

## Privacy and security

This project records audio and screen content locally. Any contribution must:

- keep all processing on-device unless a feature is explicitly opt-in for cloud use;
- never log or transmit sensitive content;
- not weaken the offline-first defaults.

Security issues should be reported privately via the repository's security policy rather than in a public issue.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE.md) like the rest of the project. If you contribute substantial code, add your name to the copyright notice in `LICENSE.md` or let us know and we will.
