/**
 * Local ed25519 token verification (homegrown JSON + ed25519 format).
 *
 * The Sigil wire protocol uses a three-segment dot-separated token:
 *   <base64url-header>.<base64url-payload>.<base64url-signature>
 *
 * The signature covers the ASCII string "<header>.<payload>" signed with an
 * ed25519 private key held by sigil-core. The 32-byte public key is delivered
 * in the task-open response and cached for the task lifetime.
 *
 * See docs/protocol.md §2 for the full specification.
 */
import nacl from "tweetnacl";

/** Decoded, validated payload extracted from a Sigil task token. */
export interface TokenPayload {
  iss: string;
  sub: string;
  tid: string;
  task: string;
  tools: string[];
  scope: Record<string, unknown>;
  iat: number;
  exp: number;
}

/** Decodes a URL-safe base64 string (no padding) into a Uint8Array. */
function decodeBase64Url(input: string): Uint8Array {
  const padded =
    input.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (input.length % 4)) % 4);
  const binary = Buffer.from(padded, "base64");
  return new Uint8Array(binary);
}

/**
 * Verifies a Sigil task token signature and expiry.
 *
 * @param token          The raw token string (three dot-separated segments).
 * @param publicKeyBytes The 32-byte ed25519 public key from the task-open response.
 * @returns              The decoded `TokenPayload` if valid.
 * @throws               `Error` if the token is malformed, expired, or has an invalid signature.
 */
export function verifyToken(
  token: string,
  publicKeyBytes: Uint8Array,
): TokenPayload {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Sigil token format invalid: expected 3 dot-separated segments");
  }

  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  const message = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = decodeBase64Url(sigB64);

  const valid = nacl.sign.detached.verify(message, signature, publicKeyBytes);
  if (!valid) {
    throw new Error("Sigil token signature verification failed");
  }

  const payloadJson = Buffer.from(decodeBase64Url(payloadB64)).toString("utf8");
  const payload = JSON.parse(payloadJson) as TokenPayload;

  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec >= payload.exp) {
    throw new Error(`Sigil token expired at ${new Date(payload.exp * 1000).toISOString()}`);
  }

  return payload;
}

/**
 * Returns true if the token's `tools` claim contains the given tool name.
 * Must be called after `verifyToken` succeeds.
 */
export function isToolAllowed(payload: TokenPayload, toolName: string): boolean {
  return payload.tools.includes(toolName);
}
