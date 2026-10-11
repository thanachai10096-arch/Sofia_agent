import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { DesktopCapability, DesktopPrincipal } from "./types.js";

export class DesktopPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopPermissionError";
  }
}

export function requireCapability(principal: DesktopPrincipal, capability: DesktopCapability): void {
  if (!principal.id.trim() || !principal.capabilities.has(capability)) {
    throw new DesktopPermissionError(`Principal is not permitted to use ${capability}.`);
  }
}

export async function resolveWorkspaceRoot(root: string): Promise<string> {
  const resolved = await realpath(path.resolve(root));
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error("Desktop workspace root must be a directory.");
  return resolved;
}

/**
 * Resolve a relative path inside the configured workspace. Existing targets are
 * realpathed to prevent symlink escapes. For new targets, every existing ancestor
 * is checked before the remaining missing path segments are appended.
 */
export async function resolveWorkspacePath(root: string, input: string, allowMissing = false): Promise<string> {
  if (!input.trim() || path.isAbsolute(input)) throw new DesktopPermissionError("Only non-empty relative workspace paths are allowed.");
  const lexical = path.resolve(root, input);
  if (!isInside(root, lexical)) throw new DesktopPermissionError("Path escapes the configured workspace.");
  try {
    const resolved = await realpath(lexical);
    if (!isInside(root, resolved)) throw new DesktopPermissionError("Resolved path escapes the configured workspace.");
    return resolved;
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    let ancestor = path.dirname(lexical);
    const missing: string[] = [path.basename(lexical)];
    while (isInside(root, ancestor)) {
      try {
        const resolvedAncestor = await realpath(ancestor);
        if (!isInside(root, resolvedAncestor)) throw new DesktopPermissionError("Parent directory escapes the configured workspace.");
        return path.join(resolvedAncestor, ...missing.reverse());
      } catch (ancestorError) {
        if ((ancestorError as NodeJS.ErrnoException).code !== "ENOENT") throw ancestorError;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      missing.push(path.basename(ancestor));
      ancestor = parent;
    }
    throw new DesktopPermissionError("Could not resolve a safe parent inside the workspace.");
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
