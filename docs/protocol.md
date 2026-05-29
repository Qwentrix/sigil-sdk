# Sigil Wire Protocol — Specification v0.1 (DRAFT)

**Status:** Draft — not yet stable; breaking changes possible before v1 GA.
**Canonical location:** Published in both `sigil-py` and `sigil-sdk` (this file). The two repos must stay in sync on every revision.
**Contact:** sigil-pod@qwentrix.com

---

## 1. Overview

The Sigil wire protocol defines the HTTP messages exchanged between:

- **Sigil SDK** (Python `sigil-py` / TypeScript `@qwentrix/sigil`) — the in-process agent-side library.
- **sigil-core** — the server-side Go control-plane at port 8120.

All messages are JSON over HTTPS (TLS 1.2+). Internal service-to-service calls use plain HTTP over the private container network (production: `sigil-core:8120`).

---

## 2. Token Format

### 2.1 Format

Sigil uses a **homegrown capability token** (not an off-the-shelf Biscuit library). The format is:

```
<base64url-encoded header>.<base64url-encoded payload>.<base64url-encoded signature>
```

Each segment is URL-safe base64 with no padding.

### 2.2 Header

```json
{
  "alg": "EdDSA",
  "kid": "<key-id — UUID of the signing keypair in sigil-core's key store>"
}
```

### 2.3 Payload

```json
{
  "iss": "sigil-core",
  "sub": "<agent_id — UUID>",
  "tid": "<tenant_id — UUID>",
  "task": "<task_id — UUID>",
  "tools": ["namespace.tool_name", ...],
  "scope": { "<scope_json as defined in §2.3 of 04-requirements-sigil.md>" },
  "iat": 1748700000,
  "exp": 1748703600
}
```

Field notes:
- `tools` — exhaustive allowlist. Any tool invocation with a name not in this array MUST be denied by the SDK before reaching the network.
- `exp` — Unix epoch seconds. SDK must check this locally before every tool call and reject if `now >= exp`.
- `scope` — mirrors `sigil_task_tokens.scope_json`; authoritative copy is the DB record.

### 2.4 Signature

The signature is an **ed25519 signature** over the ASCII string `<header>.<payload>` (the two base64url segments joined by a literal dot, no trailing newline). The signing key is a 32-byte ed25519 private key held exclusively by sigil-core. The corresponding 32-byte public key is distributed to SDKs at task-open time inside the `POST /internal/v1/sigil/tasks/open` response and cached for the task lifetime. Public keys rotate quarterly; the `kid` field is used for key selection.

**Verification (SDK side):**

```
verify_ed25519(
  public_key = task_open_response.signing_public_key,
  message    = token.split('.')[0] + '.' + token.split('.')[1],
  signature  = base64url_decode(token.split('.')[2])
)
```

A failed verification MUST result in a local deny (no network call made).

---

## 3. Preflight Request / Response

### 3.1 When to Call

The SDK sends a preflight for:
- Any tool whose `riskTier` / `risk_tier` is `"high"` or `"critical"`.
- Every 10th tool invocation regardless of risk tier (freshness probe — confirms token not revoked server-side).

Sub-1ms low-risk tools in the common path are verified **locally** using the cached token (no network).

### 3.2 Request

```
POST /internal/v1/sigil/toolgate/preflight
X-Internal-Secret: <INTERNAL_API_SECRET>
X-Sigil-Agent-Token: <biscuit_token>
Content-Type: application/json

{
  "agent_id":     "<UUID>",
  "task_id":      "<UUID>",
  "tool_name":    "<namespace.tool_name>",
  "args_hash":    "<SHA-256 hex of canonical JSON of unredacted args>",
  "args_redacted": { "<key>": "<value or redacted placeholder>" }
}
```

`args_hash` is SHA-256 of the canonical JSON encoding (RFC 8785 / JCS) of the original unredacted argument object. The SDK computes this before redaction and includes it so sigil-core can store it for non-repudiable integrity.

### 3.3 Response

```json
{
  "verdict":          "allow" | "deny" | "pending_approval",
  "denied_reason":    "<SIGIL_* error code or null>",
  "approval_id":      "<UUID or null — only present when verdict=pending_approval (v2)>",
  "latency_budget_ms": "<int or null — timeout for SDK to wait on approval (v2)>"
}
```

`denied_reason` values (partial list):
- `SIGIL_TOOL_NOT_IN_SCOPE` — tool not in `sigil_task_tokens.tool_allowlist`
- `SIGIL_TOKEN_EXPIRED` — token past `exp`
- `SIGIL_TOKEN_REVOKED` — revocation event found
- `SIGIL_TASK_CLOSED` — task already completed or killed
- `SIGIL_RESOURCE_SCOPE_DENIED` — tool would access a restricted resource classification
- `SIGIL_APPROVAL_SERVICE_UNAVAILABLE` — approval service unreachable (fail-closed, v2)

HTTP status: always `200` for a completed verdict (including deny). `4xx`/`5xx` indicate transport or server errors, not policy decisions.

---

## 4. Audit Envelope (Log-Batch)

### 4.1 Request

```
POST /internal/v1/sigil/toolgate/log-batch
X-Internal-Secret: <INTERNAL_API_SECRET>
X-Sigil-Agent-Token: <biscuit_token>
Content-Type: application/json

{
  "events": [
    {
      "agent_id":        "<UUID>",
      "task_id":         "<UUID>",
      "tool_name":       "<namespace.tool_name>",
      "tool_namespace":  "<namespace>",
      "args_hash":       "<SHA-256 hex>",
      "args_redacted":   { ... },
      "result_hash":     "<SHA-256 hex of result canonical JSON>",
      "result_sampled":  { ... },
      "latency_ms":      42,
      "outcome":         "allowed" | "denied" | "approved",
      "denied_reason":   "<SIGIL_* code or null>",
      "risk_tier":       "low" | "med" | "high" | "critical"
    }
  ]
}
```

Maximum 100 events per batch. SDK flushes every 500 ms or when 50 events accumulate, whichever comes first.

### 4.2 Response

```json
{
  "invocation_ids": ["<UUIDv7>", ...]
}
```

sigil-core ACKs immediately after writing to Redis Stream `sigil:writes`; PostgreSQL persistence is asynchronous via the `sigil-writer` goroutine pool.

P99 ACK target: 50 ms.

### 4.3 Fail-Mode Overflow

When sigil-core is unreachable and `SIGIL_FAIL_MODE=closed`:
- Denied events are written to a local NDJSON overflow file (`~/.sigil/overflow/<agent_id>_<date>.ndjson`).
- Maximum file size: 100 MB. Older files are rotated automatically.
- The SDK replays the overflow file at next successful connection.
- `sigil_sdk_unreachable_events_total` Prometheus counter increments (server-side, replayed).

When `SIGIL_FAIL_MODE=open` (development only): tool calls proceed without audit emission and a `WARN` log is emitted locally.

---

## 5. Revocation Protocol

### 5.1 Channel

sigil-core publishes revocation events on the Redis Pub/Sub channel `drm:revocation-events` (same channel used by the Sprint 35 multi-platform revocation fan-out). This reuses the existing revocation infrastructure; Sigil SDK subscribes to the same channel.

### 5.2 Revocation Message Shape

```json
{
  "revocation_id": "<UUID of sigil_revocation_events row>",
  "scope":         "single_call" | "task" | "agent" | "tenant",
  "agent_id":      "<UUID or null>",
  "task_id":       "<UUID or null>",
  "tenant_id":     "<UUID>",
  "reason":        "<human-readable string>",
  "revoked_at":    "<ISO 8601 UTC>"
}
```

### 5.3 SDK Handling

Upon receiving a revocation message the SDK must:

1. If `scope=task` and `task_id` matches the current task: immediately set task state to `revoked`; any in-flight `instrumentedTool` call in progress is allowed to complete (fail-safe); all subsequent calls deny locally with `SIGIL_TOKEN_REVOKED`.
2. If `scope=agent` and `agent_id` matches: mark the client instance as permanently revoked; all subsequent task opens and tool calls deny.
3. If `scope=tenant` and `tenant_id` matches: same as `scope=agent`.
4. If `scope=single_call`: deny the specific invocation; task continues.

P99 target for SDK receiving the revocation and stopping new tool calls: **1 second** from kill-switch activation in the UI.

---

## 6. Task Open / Close

### 6.1 Task Open

```
POST /internal/v1/sigil/tasks/open
X-Internal-Secret: <INTERNAL_API_SECRET>
Content-Type: application/json

{
  "agent_id":              "<UUID>",
  "task_type":             "<string>",
  "scope_json":            { ... },
  "initiated_by_user_id":  "<UUID or null>"
}
```

Response 201:

```json
{
  "task_id":              "<UUID>",
  "biscuit_token":        "<header>.<payload>.<signature>",
  "signing_public_key":   "<base64url-encoded 32-byte ed25519 public key>",
  "expires_at":           "<ISO 8601 UTC>"
}
```

The SDK caches `biscuit_token` and `signing_public_key` for the duration of the task.

### 6.2 Task Close

Task close is implicit: when the SDK task context exits normally, it emits a final `log-batch` flush and then calls:

```
POST /internal/v1/sigil/tasks/<task_id>/close
X-Internal-Secret: <INTERNAL_API_SECRET>
X-Sigil-Agent-Token: <biscuit_token>
Content-Type: application/json

{
  "status":      "completed" | "failed",
  "error_msg":   "<string or null>"
}
```

Response 200: `{ "closed_at": "<ISO 8601 UTC>" }`

---

*This document is a DRAFT stub. Full normative specification will be completed during SG-2 (TypeScript SDK sprint, 2026-11-30 kickoff). Until then, the Go implementation in `sigil-core` is the authoritative reference.*
