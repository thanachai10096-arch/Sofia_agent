/**
 * Sofia's 14-character mascot registry.
 * These are visual identities for product/UI use; they do not imply that each
 * capability is a separate running agent in the runtime.
 * SPDX-License-Identifier: Apache-2.0
 */
export interface SofiaCharacter {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly description: string;
  readonly asset: string;
}

export const SOFIA_CHARACTERS = [
  { id: "sofia", name: "Sofia", role: "Orchestrator", description: "Coordinates tasks and delegates work", asset: "/assets/characters/sofia.svg" },
  { id: "nova", name: "Nova", role: "Planning", description: "Breaks requests into actionable plans", asset: "/assets/characters/nova.svg" },
  { id: "pixel", name: "Pixel", role: "Coding", description: "Implements and refines code", asset: "/assets/characters/pixel.svg" },
  { id: "lumi", name: "Lumi", role: "Design", description: "Supports interface and visual design", asset: "/assets/characters/lumi.svg" },
  { id: "mira", name: "Mira", role: "Research", description: "Collects and compares evidence", asset: "/assets/characters/mira.svg" },
  { id: "echo", name: "Echo", role: "Browser", description: "Navigates browser workflows", asset: "/assets/characters/echo.svg" },
  { id: "mint", name: "Mint", role: "Testing", description: "Checks behavior and edge cases", asset: "/assets/characters/mint.svg" },
  { id: "bloom", name: "Bloom", role: "Writing", description: "Drafts and edits content", asset: "/assets/characters/bloom.svg" },
  { id: "iris", name: "Iris", role: "Analysis", description: "Reasons over structured information", asset: "/assets/characters/iris.svg" },
  { id: "velvet", name: "Velvet", role: "Security", description: "Reviews risks and permissions", asset: "/assets/characters/velvet.svg" },
  { id: "orbit", name: "Orbit", role: "Memory", description: "Organizes reusable context", asset: "/assets/characters/orbit.svg" },
  { id: "spark", name: "Spark", role: "Tooling", description: "Connects tools and actions", asset: "/assets/characters/spark.svg" },
  { id: "data", name: "Data", role: "Data", description: "Transforms and validates data", asset: "/assets/characters/data.svg" },
  { id: "pulse", name: "Pulse", role: "Operations", description: "Tracks run state and reliability", asset: "/assets/characters/pulse.svg" },
] as const satisfies readonly SofiaCharacter[];

export const SOFIA_CHARACTER_COUNT = SOFIA_CHARACTERS.length;

export function getSofiaCharacter(id: string): SofiaCharacter | undefined {
  return SOFIA_CHARACTERS.find((character) => character.id === id);
}
