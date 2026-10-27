# Security Policy

## Supported versions

Security fixes target the latest source on `main` and the 0.7.x release line. Older releases may not receive fixes; upgrade to the latest published version before reporting an issue that may already be fixed.

## Reporting a vulnerability

Do not publish credentials, personal data, screenshots, transcripts, or exploit details in a public issue.

Use GitHub's [private vulnerability reporting form](https://github.com/dk3yyyy/volyx-lens/security/advisories/new). The report is submitted privately as a draft security advisory visible to repository maintainers.

For ordinary, non-sensitive defects, use the public [issue tracker](https://github.com/dk3yyyy/volyx-lens/issues).

Please include the Volyx Lens version, the platform, reproduction steps, and the impact you believe the issue has. Redact live provider keys, transcripts, and personal data; a placeholder is enough to demonstrate a leak.

We aim to acknowledge a report within 3 business days, give an initial assessment within 10 business days, and publish a fix or mitigation within 90 days of the report where the issue is confirmed and in scope. We will coordinate disclosure with you and credit you if you want credit.

## Scope

Useful reports include credential exposure, unsafe IPC or renderer boundaries, unintended screen or audio capture, sensitive-data retention, provider-routing failures, and dependency vulnerabilities with a demonstrated impact on Volyx Lens.

Out of scope: defects in a third-party AI or transcription provider; issues that require a jailbroken operating system, physical access, or an already-compromised renderer process; and reports that only restate a provider's own retention or logging policy.
