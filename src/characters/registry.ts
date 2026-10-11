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
  { id: "sofia", name: "Sofia", role: "Orchestrator", description: "Coordinates tasks and delegates work", asset: "/assets/characters/a01-beanie-white.png" },
  { id: "nova", name: "Nova", role: "Planning", description: "Breaks requests into actionable plans", asset: "/assets/characters/a02-glasses-blue.png" },
  { id: "pixel", name: "Pixel", role: "Coding", description: "Implements and refines code", asset: "/assets/characters/a03-cap-shadow.png" },
  { id: "lumi", name: "Lumi", role: "Design", description: "Supports interface and visual design", asset: "/assets/characters/a04-cap-back-pink.png" },
  { id: "mira", name: "Mira", role: "Research", description: "Collects and compares evidence", asset: "/assets/characters/a05-curly-pink.png" },
  { id: "echo", name: "Echo", role: "Browser", description: "Navigates browser workflows", asset: "/assets/characters/a06-bob-pink.png" },
  { id: "mint", name: "Mint", role: "Testing", description: "Checks behavior and edge cases", asset: "/assets/characters/a08-curly-mint.png" },
  { id: "bloom", name: "Bloom", role: "Writing", description: "Drafts and edits content", asset: "/assets/characters/a09-spiky-pink.png" },
  { id: "iris", name: "Iris", role: "Analysis", description: "Reasons over structured information", asset: "/assets/characters/a10-spiky-violet.png" },
  { id: "velvet", name: "Velvet", role: "Security", description: "Reviews risks and permissions", asset: "/assets/characters/a12-beanie-violet.png" },
  { id: "orbit", name: "Orbit", role: "Memory", description: "Organizes reusable context", asset: "/assets/characters/a11-curly-lilac.png" },
  { id: "spark", name: "Spark", role: "Tooling", description: "Connects tools and actions", asset: "/assets/characters/a13-bob-violet.png" },
  { id: "data", name: "Data", role: "Data", description: "Transforms and validates data", asset: "/assets/characters/a07-cap-pink.png" },
  { id: "pulse", name: "Pulse", role: "Operations", description: "Tracks run state and reliability", asset: "/assets/characters/a14-tuft-lilac.png" },
] as const satisfies readonly SofiaCharacter[];

export const SOFIA_CHARACTER_COUNT = SOFIA_CHARACTERS.length;

export function getSofiaCharacter(id: string): SofiaCharacter | undefined {
  return SOFIA_CHARACTERS.find((character) => character.id === id);
}
