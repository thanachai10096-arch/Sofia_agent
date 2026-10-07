import { createHash } from "node:crypto";
import type { WorkspaceRuntime } from "../platform/runtime.js";

export interface EditOperation {
  path: string;
  expectedContent?: string;
  expectedHash?: string;
  content: string;
}

export interface EditPatch {
  id: string;
  operations: EditOperation[];
  createdAt: string;
}

export interface EditResult {
  path: string;
  changed: boolean;
  previousHash: string;
  nextHash: string;
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertRelativePath(path: string): void {
  if (!path || path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error("Edit path must be workspace-relative");
  }
}

export function createEditPatch(operations: readonly EditOperation[]): EditPatch {
  if (operations.length === 0) throw new Error("Edit patch cannot be empty");

  const seen = new Set<string>();
  for (const operation of operations) {
    assertRelativePath(operation.path);
    if (seen.has(operation.path)) throw new Error(`Duplicate edit path: ${operation.path}`);
    seen.add(operation.path);
    if (operation.expectedContent === undefined && operation.expectedHash === undefined) {
      throw new Error(`Edit requires an expected content or hash: ${operation.path}`);
    }
    if (operation.expectedContent !== undefined && operation.expectedHash !== undefined) {
      if (hash(operation.expectedContent) !== operation.expectedHash) {
        throw new Error(`Expected content/hash mismatch: ${operation.path}`);
      }
    }
  }

  const serialized = JSON.stringify(operations);
  return {
    id: createHash("sha256").update(serialized).digest("hex"),
    operations: operations.map((operation) => ({ ...operation })),
    createdAt: new Date().toISOString(),
  };
}

export async function applyEditPatch(
  runtime: WorkspaceRuntime,
  patch: EditPatch,
): Promise<EditResult[]> {
  const current = new Map<string, string>();
  for (const operation of patch.operations) {
    assertRelativePath(operation.path);
    const content = await runtime.readFile(operation.path);
    current.set(operation.path, content);

    if (operation.expectedHash && hash(content) !== operation.expectedHash) {
      throw new Error(`Edit conflict: ${operation.path} changed since planning`);
    }
    if (operation.expectedContent !== undefined && content !== operation.expectedContent) {
      throw new Error(`Edit conflict: ${operation.path} changed since planning`);
    }
  }

  const results: EditResult[] = [];
  for (const operation of patch.operations) {
    const previous = current.get(operation.path)!;
    if (previous === operation.content) {
      results.push({
        path: operation.path,
        changed: false,
        previousHash: hash(previous),
        nextHash: hash(previous),
      });
      continue;
    }

    await runtime.writeFile(operation.path, operation.content);
    results.push({
      path: operation.path,
      changed: true,
      previousHash: hash(previous),
      nextHash: hash(operation.content),
    });
  }

  return results;
}

export function unifiedDiff(oldContent: string, newContent: string, path: string): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let endOld = oldLines.length - 1;
  let endNew = newLines.length - 1;
  while (endOld >= start && endNew >= start && oldLines[endOld] === newLines[endNew]) {
    endOld--;
    endNew--;
  }
  const removed = oldLines.slice(start, endOld + 1);
  const added = newLines.slice(start, endNew + 1);
  if (removed.length === 0 && added.length === 0) return lines.join("\n");
  return [
    ...lines,
    `@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");
}
