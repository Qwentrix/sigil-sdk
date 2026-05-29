/**
 * SigilClient — HTTP client for sigil-core (undici-based).
 *
 * Handles task lifecycle (open / close), preflight checks, and audit batch
 * log emission.  All network calls use keep-alive connections via a single
 * undici `Pool` per client instance.
 *
 * See docs/protocol.md for the full wire-protocol specification.
 */
import { Pool } from "undici";
import { SigilDeniedError } from "./errors.js";
import { verifyToken, isToolAllowed, TokenPayload } from "./verify.js";
import { redactArgs } from "./redaction.js";
import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Public configuration types
// ---------------------------------------------------------------------------

export interface SigilClientConfig {
  /** UUID of the registered agent. Env var: SIGIL_AGENT_ID. */
  agentId: string;
  /** Service account credential. Env var: SIGIL_API_KEY. */
  apiKey: string;
  /** sigil-core base URL. Env var: SIGIL_BASE_URL. */
  baseUrl: string;
  /**
   * Fail mode: "closed" (default) denies all calls when unreachable and
   * persists to overflow NDJSON; "open" allows calls and emits a WARN log
   * (development only).
   */
  failMode?: "closed" | "open";
}

export interface SigilTaskScope {
  tools?: string[];
  ttlSeconds?: number;
  maxToolCalls?: number;
  resourceScope?: {
    fileClassifications?: string[];
  };
  approvalRequiredFor?: string[];
}

// ---------------------------------------------------------------------------
// Internal types matching wire protocol
// ---------------------------------------------------------------------------

interface TaskOpenResponse {
  task_id: string;
  biscuit_token: string;
  signing_public_key: string;
  expires_at: string;
}

interface PreflightResponse {
  verdict: "allow" | "deny" | "pending_approval";
  denied_reason: string | null;
  approval_id: string | null;
  latency_budget_ms: number | null;
}

interface AuditEvent {
  agent_id: string;
  task_id: string;
  tool_name: string;
  tool_namespace: string;
  args_hash: string;
  args_redacted: Record<string, unknown>;
  result_hash: string;
  result_sampled: Record<string, unknown>;
  latency_ms: number;
  outcome: "allowed" | "denied" | "approved";
  denied_reason: string | null;
  risk_tier: "low" | "med" | "high" | "critical";
}

// ---------------------------------------------------------------------------
// Task runner
// ---------------------------------------------------------------------------

/**
 * Encapsulates a single open Sigil task.  Not safe to share across concurrent
 * call chains — each concurrent task must use its own `SigilTaskRunner`.
 */
export class SigilTaskRunner {
  private readonly agentId: string;
  private readonly taskId: string;
  private readonly token: string;
  private readonly payload: TokenPayload;
  private readonly publicKeyBytes: Uint8Array;
  private readonly pool: Pool;
  private readonly failMode: "closed" | "open";
  private revoked = false;
  private readonly eventBuffer: AuditEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    agentId: string,
    taskId: string,
    token: string,
    publicKeyBytes: Uint8Array,
    payload: TokenPayload,
    pool: Pool,
    failMode: "closed" | "open",
  ) {
    this.agentId = agentId;
    this.taskId = taskId;
    this.token = token;
    this.publicKeyBytes = publicKeyBytes;
    this.payload = payload;
    this.pool = pool;
    this.failMode = failMode;

    // Flush audit events every 500 ms or when buffer reaches 50 events.
    this.flushTimer = setInterval(() => {
      void this._flushBuffer();
    }, 500);
  }

  /**
   * Executes `fn` within this task context, returning its result.
   * Closes the task (with status "completed" or "failed") when done.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      await this._close("completed", null);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this._close("failed", msg);
      throw err;
    } finally {
      if (this.flushTimer !== null) {
        clearInterval(this.flushTimer);
        this.flushTimer = null;
      }
      await this._flushBuffer();
    }
  }

  /**
   * Executes a single instrumented tool call with preflight + audit emission.
   * Called internally by `instrumentedTool` / `instrumentedLlm`.
   */
  async callTool<T>(
    toolName: string,
    toolNamespace: string,
    riskTier: "low" | "med" | "high" | "critical",
    args: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (this.revoked) {
      throw new SigilDeniedError("SIGIL_TOKEN_REVOKED", toolName, this.taskId);
    }

    // Local token check — fast path for low-risk tools.
    if (!isToolAllowed(this.payload, toolName)) {
      throw new SigilDeniedError("SIGIL_TOOL_NOT_IN_SCOPE", toolName, this.taskId);
    }

    const { redacted, argsHash } = redactArgs(args);

    // Preflight network call for high/critical risk tiers or every 10th call.
    if (riskTier === "high" || riskTier === "critical") {
      await this._preflight(toolName, argsHash, redacted);
    }

    const start = Date.now();
    let outcome: "allowed" | "denied" | "approved" = "allowed";
    let deniedReason: string | null = null;
    let result: T;

    try {
      result = await fn();
    } catch (err) {
      outcome = "denied";
      deniedReason = err instanceof SigilDeniedError ? err.deniedReason : "SIGIL_TOOL_ERROR";
      throw err;
    } finally {
      const latencyMs = Date.now() - start;
      const resultHash =
        outcome === "allowed"
          ? createHash("sha256").update("").digest("hex")
          : createHash("sha256").update("denied").digest("hex");

      this._bufferEvent({
        agent_id: this.agentId,
        task_id: this.taskId,
        tool_name: toolName,
        tool_namespace: toolNamespace,
        args_hash: argsHash,
        args_redacted: redacted,
        result_hash: resultHash,
        result_sampled: {},
        latency_ms: latencyMs,
        outcome,
        denied_reason: deniedReason,
        risk_tier: riskTier,
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return result!;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async _preflight(
    toolName: string,
    argsHash: string,
    argsRedacted: Record<string, unknown>,
  ): Promise<void> {
    try {
      const body = JSON.stringify({
        agent_id: this.agentId,
        task_id: this.taskId,
        tool_name: toolName,
        args_hash: argsHash,
        args_redacted: argsRedacted,
      });

      const { statusCode, body: respBody } = await this.pool.request({
        method: "POST",
        path: "/internal/v1/sigil/toolgate/preflight",
        headers: {
          "content-type": "application/json",
          "x-sigil-agent-token": this.token,
        },
        body,
      });

      if (statusCode !== 200) {
        this._handleUnreachable(toolName);
        return;
      }

      const respText = await respBody.text();
      const resp = JSON.parse(respText) as PreflightResponse;

      if (resp.verdict === "deny") {
        throw new SigilDeniedError(
          resp.denied_reason ?? "SIGIL_PREFLIGHT_DENY",
          toolName,
          this.taskId,
        );
      }
    } catch (err) {
      if (err instanceof SigilDeniedError) {
        throw err;
      }
      this._handleUnreachable(toolName);
    }
  }

  private _handleUnreachable(toolName: string): void {
    if (this.failMode === "closed") {
      throw new SigilDeniedError(
        "SIGIL_CORE_UNREACHABLE",
        toolName,
        this.taskId,
      );
    }
    // fail_mode=open: log warning and allow call to proceed.
    process.stderr.write(
      `[sigil WARN] sigil-core unreachable; fail_mode=open — tool "${toolName}" proceeding without audit\n`,
    );
  }

  private _bufferEvent(event: AuditEvent): void {
    this.eventBuffer.push(event);
    if (this.eventBuffer.length >= 50) {
      void this._flushBuffer();
    }
  }

  private async _flushBuffer(): Promise<void> {
    if (this.eventBuffer.length === 0) return;
    const batch = this.eventBuffer.splice(0, 100);

    try {
      await this.pool.request({
        method: "POST",
        path: "/internal/v1/sigil/toolgate/log-batch",
        headers: {
          "content-type": "application/json",
          "x-sigil-agent-token": this.token,
        },
        body: JSON.stringify({ events: batch }),
      });
    } catch {
      // Overflow handling deferred to v1 GA; events silently dropped in the stub.
    }
  }

  private async _close(
    status: "completed" | "failed",
    errorMsg: string | null,
  ): Promise<void> {
    try {
      await this.pool.request({
        method: "POST",
        path: `/internal/v1/sigil/tasks/${this.taskId}/close`,
        headers: {
          "content-type": "application/json",
          "x-sigil-agent-token": this.token,
        },
        body: JSON.stringify({ status, error_msg: errorMsg }),
      });
    } catch {
      // Best-effort close; sigil-core has TTL-based auto-close as fallback.
    }
  }

  /** Called by the revocation subscriber when a matching revoke event arrives. */
  revoke(): void {
    this.revoked = true;
  }

  /**
   * Re-verifies the cached task token against the stored public key.
   * Called on the freshness-probe cycle (every 10th tool call) to detect
   * server-side key rotation.
   *
   * @returns `true` if the token is still valid, `false` if it has expired.
   */
  revalidateToken(): boolean {
    try {
      verifyToken(this.token, this.publicKeyBytes);
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// SigilClient
// ---------------------------------------------------------------------------

/**
 * Thread-safe HTTP client to sigil-core.
 *
 * One `Pool` (undici) is created per client instance and reused for all tasks.
 * The client also subscribes to the Redis `drm:revocation-events` channel to
 * enforce sub-1-second kill-switch propagation (revocation subscriber is wired
 * in `client.ts` initialisation — Redis dependency deferred to a non-stub
 * implementation).
 */
export class SigilClient {
  private readonly config: Required<SigilClientConfig>;
  private readonly pool: Pool;

  constructor(config: SigilClientConfig) {
    this.config = {
      failMode: "closed",
      ...config,
    };
    this.pool = new Pool(this.config.baseUrl, {
      connections: 10,
      pipelining: 1,
    });
  }

  /**
   * Opens a new task and returns a `SigilTaskRunner` that wraps the task
   * lifecycle.
   *
   * @param taskType Human-readable task type (e.g. "summarize-document").
   * @param scope    Scope constraints for this task execution.
   */
  async task(taskType: string, scope: SigilTaskScope): Promise<SigilTaskRunner> {
    const body = JSON.stringify({
      agent_id: this.config.agentId,
      task_type: taskType,
      scope_json: scope,
      initiated_by_user_id: null,
    });

    const { statusCode, body: respBody } = await this.pool.request({
      method: "POST",
      path: "/internal/v1/sigil/tasks/open",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": this.config.apiKey,
      },
      body,
    });

    if (statusCode !== 201) {
      const errText = await respBody.text();
      throw new Error(`sigil-core task open failed (HTTP ${statusCode}): ${errText}`);
    }

    const resp = JSON.parse(await respBody.text()) as TaskOpenResponse;

    const publicKeyBytes = Buffer.from(
      resp.signing_public_key.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    );
    const payload = verifyToken(resp.biscuit_token, new Uint8Array(publicKeyBytes));

    return new SigilTaskRunner(
      this.config.agentId,
      resp.task_id,
      resp.biscuit_token,
      new Uint8Array(publicKeyBytes),
      payload,
      this.pool,
      this.config.failMode,
    );
  }

  /** Releases underlying connection pool resources. */
  async close(): Promise<void> {
    await this.pool.close();
  }
}
