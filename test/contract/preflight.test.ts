/**
 * Contract tests — preflight endpoint
 *
 * These tests verify the SDK's behaviour against a sigil-core fixture server.
 * In CI the fixture is a lightweight HTTP mock that returns canonical responses
 * matching the wire-protocol spec (docs/protocol.md §3).
 *
 * Run with: npm test
 *
 * Prerequisites:
 * - Set SIGIL_TEST_BASE_URL to a running sigil-core instance or mock server.
 *   Falls back to "http://localhost:8120" when the env var is absent.
 * - A pre-registered test agent + service account credential must be available
 *   via SIGIL_TEST_AGENT_ID and SIGIL_TEST_API_KEY env vars.  When absent the
 *   tests are skipped with a clear message (they require the fixture server).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SigilClient, SigilDeniedError } from "../../src/index.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const BASE_URL = process.env["SIGIL_TEST_BASE_URL"] ?? "http://localhost:8120";
const AGENT_ID = process.env["SIGIL_TEST_AGENT_ID"] ?? "";
const API_KEY = process.env["SIGIL_TEST_API_KEY"] ?? "";

/** Skip all contract tests when fixture server credentials are not configured. */
const FIXTURE_AVAILABLE = AGENT_ID !== "" && API_KEY !== "";

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!FIXTURE_AVAILABLE)(
  "preflight contract (requires sigil-core fixture)",
  () => {
    let client: SigilClient;

    beforeAll(() => {
      client = new SigilClient({
        agentId: AGENT_ID,
        apiKey: API_KEY,
        baseUrl: BASE_URL,
        failMode: "closed",
      });
    });

    afterAll(async () => {
      await client.close();
    });

    // -----------------------------------------------------------------------
    // Task open
    // -----------------------------------------------------------------------

    it("opens a task and returns a valid biscuit token", async () => {
      const runner = await client.task("contract-test", {
        tools: ["zep.search"],
        ttlSeconds: 60,
        maxToolCalls: 10,
      });
      expect(runner).toBeTruthy();
      // Clean up — run a no-op to close the task.
      await runner.run(async () => undefined);
    });

    // -----------------------------------------------------------------------
    // Preflight — allow
    // -----------------------------------------------------------------------

    it("allows a low-risk tool that is in scope", async () => {
      const runner = await client.task("contract-test-allow", {
        tools: ["zep.search"],
        ttlSeconds: 60,
        maxToolCalls: 10,
      });

      let callCount = 0;
      await runner.run(async () => {
        // instrumentedTool is tested via runner.callTool directly here for
        // isolation from the decorator layer.
        await runner.callTool("zep.search", "zep", "low", { query: "test" }, async () => {
          callCount++;
          return { hits: 0 };
        });
      });

      expect(callCount).toBe(1);
    });

    // -----------------------------------------------------------------------
    // Preflight — deny (tool not in scope)
    // -----------------------------------------------------------------------

    it("denies a tool that is NOT in the task scope", async () => {
      const runner = await client.task("contract-test-deny", {
        tools: ["zep.search"],
        ttlSeconds: 60,
        maxToolCalls: 10,
      });

      await expect(
        runner.run(async () => {
          // "db.write" is not in the scope — should be denied by local token check.
          await runner.callTool("db.write", "db", "high", { table: "users", op: "UPDATE" }, async () => {
            return { rows: 0 };
          });
        }),
      ).rejects.toThrow(SigilDeniedError);
    });

    // -----------------------------------------------------------------------
    // SigilDeniedError shape
    // -----------------------------------------------------------------------

    it("SigilDeniedError carries deniedReason, toolName, and taskId", async () => {
      const runner = await client.task("contract-test-error-shape", {
        tools: ["zep.search"],
        ttlSeconds: 60,
        maxToolCalls: 10,
      });

      let caughtError: SigilDeniedError | null = null;

      try {
        await runner.run(async () => {
          await runner.callTool(
            "db.write",
            "db",
            "high",
            { table: "users" },
            async () => ({ rows: 0 }),
          );
        });
      } catch (err) {
        if (err instanceof SigilDeniedError) {
          caughtError = err;
        }
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError?.deniedReason).toBe("SIGIL_TOOL_NOT_IN_SCOPE");
      expect(caughtError?.toolName).toBe("db.write");
      expect(typeof caughtError?.taskId).toBe("string");
      expect(caughtError?.taskId.length).toBeGreaterThan(0);
    });

    // -----------------------------------------------------------------------
    // Fail-mode closed — unreachable server
    // -----------------------------------------------------------------------

    it("fail-mode=closed denies high-risk calls when server unreachable", async () => {
      const unreachableClient = new SigilClient({
        agentId: AGENT_ID,
        apiKey: API_KEY,
        baseUrl: "http://127.0.0.1:19999",
        failMode: "closed",
      });

      await expect(
        // Task open itself will fail because the server is unreachable.
        unreachableClient.task("fail-closed-test", { tools: ["zep.search"] }),
      ).rejects.toThrow();

      await unreachableClient.close();
    });
  },
);

// ---------------------------------------------------------------------------
// Unit-level contract tests (no fixture required)
// ---------------------------------------------------------------------------

describe("SigilDeniedError unit contract", () => {
  it("is an instance of Error", () => {
    const err = new SigilDeniedError("SIGIL_TOKEN_EXPIRED", "zep.search", "task-123");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SigilDeniedError);
  });

  it("exposes structured fields", () => {
    const err = new SigilDeniedError("SIGIL_TOOL_NOT_IN_SCOPE", "db.write", "task-456");
    expect(err.deniedReason).toBe("SIGIL_TOOL_NOT_IN_SCOPE");
    expect(err.toolName).toBe("db.write");
    expect(err.taskId).toBe("task-456");
    expect(err.message).toContain("db.write");
    expect(err.name).toBe("SigilDeniedError");
  });
});
