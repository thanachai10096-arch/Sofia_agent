export type SofiaCliInvocation =
  | { command: "help" | "setup" | "chat" | "init" | "status" }
  | { command: "run"; task: string };

/** Resolve argv without side effects so command routing can be regression-tested. */
export function resolveCliInvocation(args: readonly string[]): SofiaCliInvocation {
  const [command, ...rest] = args;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
      return { command: "help" };
    case "setup":
    case "chat":
    case "init":
    case "status":
      return { command };
    case "run":
      return { command: "run", task: rest.join(" ") };
    default:
      return { command: "help" };
  }
}
