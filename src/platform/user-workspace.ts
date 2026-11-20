import { createHash } from "node:crypto";
import path from "node:path";
import { sofiaStateDirectory } from "./state-directory.js";

/** Return a stable, non-identifying workspace path for an authenticated principal. */
export function principalWorkspacePath(principalId: string | undefined, root?: string): string {
  const identity = principalId?.trim() || "local-instance";
  const namespace = createHash("sha256").update(identity).digest("hex");
  const configuredRoot = root?.trim() || process.env.SOFIA_USER_WORKSPACES_DIR?.trim() || sofiaStateDirectory("user-workspaces");
  if (!path.isAbsolute(configuredRoot)) {
    throw new Error("User workspace root must be an absolute path.");
  }
  const workspaceRoot = path.resolve(configuredRoot);
  return path.join(workspaceRoot, namespace);
}
