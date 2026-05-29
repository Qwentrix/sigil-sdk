/**
 * Sensitive-data redaction before audit-log emission.
 *
 * The SDK redacts values from tool arguments before sending them to sigil-core
 * so that PHI, PII, and other sensitive data never leave the agent process in
 * cleartext. The args_hash (SHA-256 of the *original* args) is computed before
 * redaction and provides non-repudiable integrity.
 *
 * See docs/protocol.md §4 and 04-requirements-sigil.md §2.3 for the schema.
 */
import { createHash } from "crypto";

/** DLP classifier categories supported in v1. */
export type DlpCategory =
  | "PERSON_NAME"
  | "EMAIL"
  | "PHONE"
  | "SSN"
  | "CREDIT_CARD"
  | "IP_ADDRESS"
  | "DATE_OF_BIRTH"
  | "PHI"
  | "CUSTOM";

/** Result of redacting a tool argument object. */
export interface RedactionResult {
  /** Top-level keys preserved; matched values replaced with redaction placeholders. */
  redacted: Record<string, unknown>;
  /** SHA-256 hex of the canonical JSON of the *original* (pre-redaction) args. */
  argsHash: string;
}

// Stub patterns — production patterns will be comprehensive regexes + ML classifiers.
const REDACTION_PATTERNS: Array<{ category: DlpCategory; pattern: RegExp }> = [
  { category: "EMAIL", pattern: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },
  { category: "PHONE", pattern: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
  { category: "SSN", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { category: "CREDIT_CARD", pattern: /\b(?:\d[ \-]?){13,16}\b/g },
  { category: "IP_ADDRESS", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
];

/**
 * Redacts sensitive values from a string using the built-in DLP patterns.
 */
function redactString(value: string): string {
  let result = value;
  for (const { category, pattern } of REDACTION_PATTERNS) {
    result = result.replace(pattern, `<PII:${category}>`);
  }
  return result;
}

/**
 * Recursively redacts sensitive values from an object.
 * Top-level keys are always preserved (see §2.3 of the requirements).
 */
function redactValue(value: unknown, depth: number): unknown {
  if (depth > 10) {
    // Guard against deeply nested structures.
    return "<REDACTED:MAX_DEPTH>";
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = redactValue(v, depth + 1);
    }
    return result;
  }
  return value;
}

/**
 * Computes the SHA-256 hex of the canonical JSON encoding of `args`.
 *
 * The canonical form is `JSON.stringify` with no extra whitespace and keys in
 * insertion order (sufficient for v1; RFC 8785 / JCS strict canonicalization
 * is deferred to v2).
 */
export function hashArgs(args: Record<string, unknown>): string {
  const canonical = JSON.stringify(args);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Redacts `args` and returns both the redacted copy and the pre-redaction hash.
 *
 * This is the primary entry point used by the instrumented wrappers before
 * sending the audit envelope to sigil-core.
 */
export function redactArgs(args: Record<string, unknown>): RedactionResult {
  const argsHash = hashArgs(args);
  const redacted = redactValue(args, 0) as Record<string, unknown>;
  return { redacted, argsHash };
}
