/**
 * Error thrown by the Sigil SDK when a tool invocation is denied by sigil-core
 * or by the local token verifier.
 */
export class SigilDeniedError extends Error {
  /** Machine-readable denial code (e.g. SIGIL_TOOL_NOT_IN_SCOPE). */
  public readonly deniedReason: string;
  /** The tool name that was denied. */
  public readonly toolName: string;
  /** The task ID under which the denial occurred. */
  public readonly taskId: string;

  constructor(deniedReason: string, toolName: string, taskId: string) {
    super(
      `Sigil denied tool "${toolName}" in task "${taskId}": ${deniedReason}`,
    );
    this.name = "SigilDeniedError";
    this.deniedReason = deniedReason;
    this.toolName = toolName;
    this.taskId = taskId;
    // Restore prototype chain when targeting ES5-compatible runtimes.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
