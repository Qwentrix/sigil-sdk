# @qwentrix/sigil

TypeScript/Node.js SDK for embedding AI agent governance into your applications using [Micelium Sigil](https://sigil.micelium.com/docs).

Sigil wraps every AI agent action — tool calls, LLM invocations, multi-agent handoffs — with a sub-millisecond in-process token check and an immutable audit record. High-risk tool calls can be gated behind a human-approval workflow. A real-time kill switch revokes any running agent within one second.

## Requirements

- Node.js >= 18
- A registered Sigil agent (`SIGIL_AGENT_ID`) and service-account key (`SIGIL_API_KEY`)
- A reachable `sigil-core` instance (`SIGIL_BASE_URL`)

## Installation

```bash
npm install @qwentrix/sigil
```

## Quick Start

```typescript
import { SigilClient, instrumentedTool, SigilDeniedError } from "@qwentrix/sigil";

// 1. Create a client (reads env vars by default when not passed explicitly)
const sigil = new SigilClient({
  agentId: process.env.SIGIL_AGENT_ID!,
  apiKey: process.env.SIGIL_API_KEY!,
  baseUrl: process.env.SIGIL_BASE_URL ?? "http://sigil-core:8120",
  failMode: "closed", // "open" for development only
});

// 2. Wrap your tools with governance instrumentation
const searchDocuments = instrumentedTool(
  "zep.search",
  async (query: string) => {
    // ... your actual tool implementation
    return [];
  },
  { riskTier: "low" }
);

// 3. Open a governed task scope, then call your tools inside it
async function runAgent() {
  const runner = sigil.task("summarize-document", {
    tools: ["zep.search"],
    ttlSeconds: 600,
    maxToolCalls: 100,
  });

  const result = await runner.run(async () => {
    try {
      const hits = await searchDocuments("Q4 financial results");
      return hits;
    } catch (err) {
      if (err instanceof SigilDeniedError) {
        console.error(`Tool denied: ${err.deniedReason} (tool=${err.toolName})`);
        throw err;
      }
      throw err;
    }
  });

  return result;
}

runAgent().catch(console.error);
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SIGIL_AGENT_ID` | Yes | UUID of the registered Sigil agent |
| `SIGIL_API_KEY` | Yes | Service-account credential from agent registration |
| `SIGIL_BASE_URL` | Yes | Base URL of the `sigil-core` service |
| `SIGIL_FAIL_MODE` | No | `"closed"` (default — deny on unreachable) or `"open"` (dev only) |

## API Reference

Full API docs at [sigil.micelium.com/docs](https://sigil.micelium.com/docs).

### `SigilClient`

| Method | Description |
|---|---|
| `new SigilClient(config)` | Create a client. Config fields map to the env vars above. |
| `client.task(taskType, scope)` | Open a governed task scope. Returns a `SigilTaskRunner`. |

### `SigilTaskRunner`

| Method | Description |
|---|---|
| `runner.run(fn)` | Execute `fn` inside the governed task. Opens a task token, runs `fn`, closes on completion or error. |

### `instrumentedTool(name, fn, options?)`

Wraps a function with Sigil tool-gate enforcement. Runs a preflight check for high-risk calls and records every invocation in the immutable audit log.

### `instrumentedLlm(model, fn)`

Wraps an LLM call with Sigil prompt/response logging, redacting PII/PHI before audit emission.

### `SigilDeniedError`

Thrown when a tool invocation is denied. Properties: `deniedReason`, `toolName`, `taskId`.

## Wire Protocol

See [docs/protocol.md](docs/protocol.md) for the JSON+ed25519 wire protocol shared by `@qwentrix/sigil` and `sigil-py`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). All contributors must sign the Qwentrix CLA.

## Security

Vulnerability reports: see [SECURITY.md](SECURITY.md).

## License

Apache 2.0 — see [LICENSE](LICENSE).
