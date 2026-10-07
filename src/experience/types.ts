export type SofiaUserMode = "simple" | "guided" | "pro";

export interface SofiaExperienceOptions {
  /**
   * Controls how much implementation detail is exposed to the user.
   * It never changes model selection or execution safety.
   */
  mode?: SofiaUserMode;
  /**
   * When true, emit short human-readable progress events alongside
   * the detailed engineering trace.
   */
  explainProgress?: boolean;
}

export interface SofiaProgress {
  phase:
    | "understand"
    | "plan"
    | "build"
    | "test"
    | "repair"
    | "review"
    | "done"
    | "blocked";
  title: string;
  detail?: string;
  technical?: string;
}

export function modeFor(options?: SofiaExperienceOptions): SofiaUserMode {
  return options?.mode ?? "simple";
}
