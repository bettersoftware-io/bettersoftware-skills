// Decides whether a tool call, as a whole, is one the hook may approve.
//
// The host runs the call, not the command text alone. So before the text is
// read at all, three things about the call must hold. Each is an allowlist:
// what is not named here is "no".
//
//   1. The tool is `Bash`.
//   2. Every field of its input is one known not to change how or where the
//      command runs. A field this file does not name is refused, so a field
//      added to the tool later approves nothing until someone decides.
//   3. The call runs in a checkout or a worktree of this project's own
//      repository. The payload must say where (`cwd`), and saying nothing is
//      a "no".

/** The fields of a Bash call that may be present, and the values they may have. */
const APPROVABLE_FIELDS: Record<string, (value: unknown) => boolean> = {
  // Judged below: it must be text.
  command: () => true,
  // Text shown to the person. It runs nothing.
  description: () => true,
  // How long the command may take. It changes when it stops, not what it does.
  timeout: () => true,
  // In the background nobody reads the result before the next step. Only an explicit "no" is approved.
  run_in_background: (value) => value === false,
  // Outside the sandbox the command reaches what the sandbox keeps from it. Only an explicit "no" is approved.
  dangerouslyDisableSandbox: (value) => value === false,
};

/** The fields a host sends that the approval reads. */
export interface CallPayload {
  tool_name?: unknown;
  tool_input?: unknown;
  cwd?: unknown;
}

/**
 * The command text of a call that may be approved, or undefined when the
 * call is not one. `isOwnCheckout` answers whether a folder is a checkout of
 * this project's repository.
 */
export function approvableCommand(payload: CallPayload, isOwnCheckout: (cwd: string) => boolean): string | undefined {
  const input = payload.tool_input;

  if (payload.tool_name !== "Bash" || input === undefined || input === null) {
    return undefined;
  }

  for (const [field, value] of Object.entries(input)) {
    if (!Object.hasOwn(APPROVABLE_FIELDS, field) || !(APPROVABLE_FIELDS[field] as (value: unknown) => boolean)(value)) {
      return undefined;
    }
  }

  const { command } = input as { command?: unknown };

  if (typeof command !== "string" || typeof payload.cwd !== "string" || payload.cwd === "" || !isOwnCheckout(payload.cwd)) {
    return undefined;
  }

  return command;
}
