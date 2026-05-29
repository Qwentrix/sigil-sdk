/**
 * @qwentrix/sigil — Public API surface.
 *
 * @example
 * ```ts
 * import { SigilClient, instrumentedTool, SigilDeniedError } from "@qwentrix/sigil";
 *
 * const client = new SigilClient({
 *   agentId:  process.env.SIGIL_AGENT_ID!,
 *   apiKey:   process.env.SIGIL_API_KEY!,
 *   baseUrl:  process.env.SIGIL_BASE_URL!,
 *   failMode: "closed",
 * });
 *
 * const search = instrumentedTool("zep.search", async (args) => { ... }, { riskTier: "low" });
 *
 * const runner = await client.task("research", { tools: ["zep.search"], ttlSeconds: 600 });
 * await runner.run(async () => {
 *   const hits = await search({ query: "Q4 results" }, runner);
 *   console.log(hits);
 * });
 * ```
 */

export { SigilClient } from "./client.js";
export type { SigilClientConfig, SigilTaskScope, SigilTaskRunner } from "./client.js";

export { instrumentedTool, instrumentedLlm } from "./decorators.js";
export type { InstrumentedToolOptions, InstrumentedLlmOptions } from "./decorators.js";

export { SigilDeniedError } from "./errors.js";

export { verifyToken, isToolAllowed } from "./verify.js";
export type { TokenPayload } from "./verify.js";

export { redactArgs, hashArgs } from "./redaction.js";
export type { RedactionResult, DlpCategory } from "./redaction.js";
