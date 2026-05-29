/**
 * Higher-order wrapper functions that instrument tool and LLM calls with
 * Sigil governance (preflight check + audit emission).
 *
 * These are plain functions (not TypeScript experimental decorators) so they
 * work without `experimentalDecorators` in the caller's tsconfig.  The
 * experimental decorator variants will be added in v2.
 *
 * Usage:
 *
 * ```ts
 * const search = instrumentedTool("zep.search", mySearchFn, { riskTier: "low" });
 * const completion = instrumentedLlm("openai/gpt-4o", callLlm);
 *
 * const client = new SigilClient({ agentId, apiKey, baseUrl });
 * const runner = await client.task("research", { tools: ["zep.search"] });
 * await runner.run(async () => {
 *   const hits = await search({ query: "Q4 results" }, runner);
 * });
 * ```
 *
 * Note: each instrumented call requires the active `SigilTaskRunner` as its
 * last argument so the SDK can emit the audit event for the correct task.
 */
import { SigilTaskRunner } from "./client.js";

/** Options for `instrumentedTool`. */
export interface InstrumentedToolOptions {
  riskTier?: "low" | "med" | "high" | "critical";
}

/**
 * Wraps a tool function so that every invocation is governed by Sigil:
 * - Local token scope check (always, sub-millisecond).
 * - Preflight network call (for high/critical risk tiers).
 * - Audit event buffered and flushed to sigil-core.
 *
 * The wrapped function has the same signature as `fn` but requires an
 * additional trailing `SigilTaskRunner` argument.
 *
 * @param name    Fully-qualified tool name ("namespace.tool_name").
 * @param fn      The original tool implementation.
 * @param options Governance options (default: riskTier = "low").
 */
export function instrumentedTool<
  TArgs extends Record<string, unknown>,
  TReturn,
>(
  name: string,
  fn: (args: TArgs) => Promise<TReturn>,
  options: InstrumentedToolOptions = {},
): (args: TArgs, runner: SigilTaskRunner) => Promise<TReturn> {
  const riskTier = options.riskTier ?? "low";
  const [namespace] = name.split(".");

  return async (args: TArgs, runner: SigilTaskRunner): Promise<TReturn> => {
    return runner.callTool(
      name,
      namespace ?? name,
      riskTier,
      args as unknown as Record<string, unknown>,
      () => fn(args),
    );
  };
}

/** Options for `instrumentedLlm`. */
export interface InstrumentedLlmOptions {
  /**
   * Override risk tier; defaults to "med" because LLM calls process
   * potentially sensitive input/output data.
   */
  riskTier?: "low" | "med" | "high" | "critical";
}

/**
 * Wraps an LLM call function so that every invocation is audited by Sigil.
 *
 * LLM calls are registered under the synthetic tool name `llm.<model>` in the
 * audit log.  The prompt and response are hashed (never logged in cleartext)
 * and stored in `sigil_prompt_logs` via the audit batch endpoint.
 *
 * @param model   Model identifier (e.g. "openai/gpt-4o").
 * @param fn      The original LLM call implementation.
 * @param options Governance options (default: riskTier = "med").
 */
export function instrumentedLlm<
  TArgs extends Record<string, unknown>,
  TReturn,
>(
  model: string,
  fn: (args: TArgs) => Promise<TReturn>,
  options: InstrumentedLlmOptions = {},
): (args: TArgs, runner: SigilTaskRunner) => Promise<TReturn> {
  const riskTier = options.riskTier ?? "med";
  const toolName = `llm.${model}`;

  return async (args: TArgs, runner: SigilTaskRunner): Promise<TReturn> => {
    return runner.callTool(
      toolName,
      "llm",
      riskTier,
      args as unknown as Record<string, unknown>,
      () => fn(args),
    );
  };
}
