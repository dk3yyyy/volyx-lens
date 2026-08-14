# Contributing to Volyx Lens

Thanks for wanting to contribute. Volyx Lens is a privacy-first macOS context assistant, and outside contributions are what make it a real open-source project.

## Getting started

1. Fork the repository and clone your fork.
2. Install dependencies: `npm install`
3. Run the checks before you start: `npm test` and `npm run check:syntax`

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

## Privacy and security

This project records audio and screen content locally. Any contribution must:

- keep all processing on-device unless a feature is explicitly opt-in for cloud use;
- never log or transmit sensitive content;
- not weaken the offline-first defaults.

Security issues should be reported privately via the repository's security policy rather than in a public issue.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE.md) like the rest of the project. If you contribute substantial code, add your name to the copyright notice in `LICENSE.md` or let us know and we will.
