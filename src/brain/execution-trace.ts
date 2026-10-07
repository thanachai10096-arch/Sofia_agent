import type { BrainEvent } from "./types.js";

export interface ExecutionTraceEntry extends BrainEvent {
  sequence: number;
  timestamp: string;
}

export interface ExecutionTraceOptions {
  maxEntries?: number;
  clock?: () => string;
}

const DEFAULT_MAX_ENTRIES = 500;

export class ExecutionTrace {
  private readonly entries: ExecutionTraceEntry[] = [];
  private nextSequence = 1;
  private readonly maxEntries: number;
  private readonly clock: () => string;

  constructor(options: ExecutionTraceOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.clock = options.clock ?? (() => new Date().toISOString());

    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new Error("Invalid execution trace limit");
    }
  }

  append(event: BrainEvent): void {
    this.entries.push({
      ...event,
      sequence: this.nextSequence++,
      timestamp: this.clock(),
    });

    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  snapshot(): ExecutionTraceEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  get size(): number {
    return this.entries.length;
  }
}
