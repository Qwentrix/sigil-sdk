# Contributing to @qwentrix/sigil

Thank you for your interest in contributing to the Micelium Sigil TypeScript SDK.

## Contributor License Agreement (CLA)

All contributors must sign the Qwentrix Individual CLA before any pull request can be merged. The CLA bot will prompt you automatically when you open your first PR.

If you are contributing on behalf of a company, your employer must also sign the Qwentrix Corporate CLA. Contact legal@qwentrix.com for the corporate CLA form.

## Development Setup

```bash
# Clone the repository
git clone https://github.com/Qwentrix/sigil-sdk.git
cd sigil-sdk

# Install dependencies (Node.js >= 18 required)
npm install

# Run the full check suite
npm run typecheck   # tsc --noEmit (strict mode)
npm run lint        # ESLint
npm run format:check # Prettier
npm test            # Vitest
```

## Code Style

This project enforces:

- **TypeScript strict mode** (`"strict": true` in `tsconfig.json`). All code must pass `tsc --noEmit` with zero errors before a PR is opened. `@ts-ignore` and `@ts-expect-error` suppression comments must include a written justification.
- **ESLint** with `@typescript-eslint` rules. Run `npm run lint` and fix all errors before opening a PR.
- **Prettier** for formatting. Run `npm run format` before committing, or configure your editor to format on save. CI enforces `npm run format:check`.

Do not disable ESLint rules inline without a comment explaining why.

## Testing Expectations

- All new public-API surface must have unit tests covering the happy path and at least one error/denial path.
- The contract test in `test/contract/preflight.test.ts` must pass. If your change alters the wire protocol, update `docs/protocol.md` in the same PR.
- Coverage threshold: 80% line coverage for `src/`. Running `npm test -- --coverage` will report coverage.
- Tests must not make live network calls. Use vitest mock utilities or stub the `undici` client.

## Pull Request Process

1. Fork the repository and create a feature branch from `main`.
2. Make your changes; ensure `npm run typecheck && npm run lint && npm run format:check && npm test` all pass locally.
3. Open a pull request against `main`. The CLA bot will check your signature.
4. At least one member of `@qwentrix/sigil-pod` must approve before merge.
5. Squash-merge is preferred for small changes; merge commits are acceptable for large feature branches.

## Wire Protocol Changes

The token format and preflight request/response shapes are part of the shared wire protocol documented in `docs/protocol.md` and mirrored in the `sigil-py` Python SDK. Any change to the protocol requires:
1. An update to `docs/protocol.md` with a version bump.
2. A corresponding PR in `sigil-py` to keep both SDKs in sync.
3. A note in the PR description explaining backward-compatibility impact.

## Reporting Bugs

Open a GitHub issue. For security vulnerabilities, see [SECURITY.md](SECURITY.md) and email security@qwentrix.com instead.
