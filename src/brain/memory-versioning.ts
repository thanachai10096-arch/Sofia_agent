import { createHash } from "node:crypto";
import type { ProjectMemoryEntry, ProjectMemoryStore } from "./project-memory.js";
export interface ProjectMemoryVersionMetadata { actor: string; reason: string; occurredAt?: string; }
export interface ProjectMemoryVersion { versionId: string; memoryId: string; project: string; actor: string; reason: string; occurredAt: string; snapshot: ProjectMemoryEntry; }
export interface ProjectMemoryVersionResult { saved: boolean; reason: "saved" | "invalid-entry" | "invalid-metadata" | "not-found" | "invalid-version" | "snapshot-too-large"; entry?: ProjectMemoryEntry; version?: ProjectMemoryVersion; }

export async function saveVersionedProjectMemory(store: ProjectMemoryStore, entry: ProjectMemoryEntry, metadata: ProjectMemoryVersionMetadata): Promise<ProjectMemoryVersionResult> {
  if (!isEntry(entry)) return { saved: false, reason: "invalid-entry" };
  if (!isMetadata(metadata)) return { saved: false, reason: "invalid-metadata" };
  const current = (await store.list()).find((item) => item.id === entry.id && item.project === entry.project && item.kind !== "version");
  let version: ProjectMemoryVersion | undefined;
  if (current) {
    version = createVersion(current, metadata);
    if (toVersionEntry(version).content.length > 12_000) return { saved: false, reason: "snapshot-too-large" };
    await store.save(toVersionEntry(version));
  }
  await store.save(entry);
  return { saved: true, reason: "saved", entry, ...(version ? { version } : {}) };
}
export async function rollbackProjectMemory(store: ProjectMemoryStore, project: string, versionId: string, metadata: ProjectMemoryVersionMetadata): Promise<ProjectMemoryVersionResult> {
  if (typeof project !== "string" || !project.trim() || typeof versionId !== "string" || !versionId.trim()) return { saved: false, reason: "invalid-version" };
  if (!isMetadata(metadata)) return { saved: false, reason: "invalid-metadata" };
  const entries = await store.list();
  const history = entries.find((item) => item.project === project && item.kind === "version" && item.id === versionId);
  if (!history) return { saved: false, reason: "not-found" };
  const parsed = parseVersion(history);
  if (!parsed || parsed.project !== project || parsed.versionId !== versionId) return { saved: false, reason: "invalid-version" };
  const current = entries.find((item) => item.project === project && item.id === parsed.memoryId && item.kind !== "version");
  if (!current) return { saved: false, reason: "not-found" };
  const currentVersion = createVersion(current, metadata);
  if (toVersionEntry(currentVersion).content.length > 12_000) return { saved: false, reason: "snapshot-too-large" };
  await store.save(toVersionEntry(currentVersion));
  const restored: ProjectMemoryEntry = { ...parsed.snapshot, id: current.id, project: current.project, createdAt: current.createdAt, updatedAt: metadata.occurredAt ?? new Date().toISOString(), uses: current.uses };
  await store.save(restored);
  return { saved: true, reason: "saved", entry: restored, version: currentVersion };
}
export async function listProjectMemoryVersions(store: ProjectMemoryStore, project: string, memoryId: string): Promise<ProjectMemoryVersion[]> {
  if (!project.trim() || !memoryId.trim()) return [];
  return (await store.list()).filter((entry) => entry.project === project && entry.kind === "version").map(parseVersion)
    .filter((version): version is ProjectMemoryVersion => Boolean(version && version.memoryId === memoryId && version.project === project))
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.versionId.localeCompare(b.versionId));
}
function createVersion(snapshot: ProjectMemoryEntry, metadata: ProjectMemoryVersionMetadata): ProjectMemoryVersion {
  const occurredAt = metadata.occurredAt ?? new Date().toISOString();
  const snapshotHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  const versionId = createHash("sha256").update(snapshot.project + "\u0000" + snapshot.id + "\u0000" + snapshot.updatedAt + "\u0000" + occurredAt + "\u0000" + metadata.actor + "\u0000" + metadata.reason + "\u0000" + snapshotHash).digest("hex");
  return { versionId, memoryId: snapshot.id, project: snapshot.project, actor: metadata.actor.trim(), reason: metadata.reason.trim(), occurredAt, snapshot: { ...snapshot } };
}
function toVersionEntry(version: ProjectMemoryVersion): ProjectMemoryEntry {
  return { id: version.versionId, project: version.project, kind: "version", content: JSON.stringify(version), source: "memory-version-history", confidence: 1, createdAt: version.occurredAt, updatedAt: version.occurredAt, uses: 0 };
}
function parseVersion(entry: ProjectMemoryEntry): ProjectMemoryVersion | undefined {
  if (entry.kind !== "version") return undefined;
  try {
    const value: unknown = JSON.parse(entry.content);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const v = value as Partial<ProjectMemoryVersion>;
    if (typeof v.versionId !== "string" || typeof v.memoryId !== "string" || typeof v.project !== "string" || typeof v.actor !== "string" || typeof v.reason !== "string" || typeof v.occurredAt !== "string" || !Number.isFinite(Date.parse(v.occurredAt)) || !isEntry(v.snapshot) || v.snapshot.id !== v.memoryId || v.snapshot.project !== v.project) return undefined;
    return v as ProjectMemoryVersion;
  } catch { return undefined; }
}
function isMetadata(v: ProjectMemoryVersionMetadata): boolean {
  return Boolean(v && typeof v.actor === "string" && v.actor.trim().length > 0 && v.actor.length <= 200 && typeof v.reason === "string" && v.reason.trim().length > 0 && v.reason.length <= 500 && (v.occurredAt === undefined || (typeof v.occurredAt === "string" && Number.isFinite(Date.parse(v.occurredAt)))));
}
function isEntry(value: unknown): value is ProjectMemoryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const e = value as Partial<ProjectMemoryEntry>;
  return typeof e.id === "string" && !!e.id.trim() && typeof e.project === "string" && !!e.project.trim() && ["convention","repair","decision","episode","feedback"].includes(e.kind ?? "") && typeof e.content === "string" && e.content.length > 0 && e.content.length <= 4_000 && typeof e.confidence === "number" && Number.isFinite(e.confidence) && e.confidence >= 0 && e.confidence <= 1 && typeof e.createdAt === "string" && Number.isFinite(Date.parse(e.createdAt)) && typeof e.updatedAt === "string" && Number.isFinite(Date.parse(e.updatedAt)) && typeof e.uses === "number" && Number.isInteger(e.uses) && e.uses >= 0;
}
