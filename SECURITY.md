# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| 0.x (pre-release) | Yes — latest commit on `main` |

Once v1.0.0 ships, the latest minor release of each major version will receive security patches.

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Email: **security@qwentrix.com**

Include in your report:
- A clear description of the vulnerability and its potential impact
- Steps to reproduce (proof-of-concept if possible)
- Affected versions
- Any suggested mitigations

You will receive an acknowledgement within **2 business days**. We aim to triage and issue an initial response within **5 business days**.

## Disclosure Policy

Qwentrix follows coordinated disclosure. We will:
1. Confirm receipt and begin triage within 2 business days.
2. Work with you to understand the issue and develop a fix.
3. Agree on a disclosure timeline (typically 90 days from initial report).
4. Credit you in the release notes unless you prefer anonymity.

We do not operate a bug bounty program at this time.

## Scope

In scope:
- Authentication and authorization bypasses in the SDK
- Token forgery or verification failures (ed25519 verification in `src/verify.ts`)
- DLP redaction bypasses that could leak PII/PHI in audit logs
- Denial-of-service vectors within the SDK itself

Out of scope:
- Vulnerabilities in `sigil-core` server (report to security@qwentrix.com with subject "sigil-core")
- Issues requiring physical access to the host machine
- Social engineering attacks
