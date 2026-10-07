export interface ExecutionPolicy {
  allowTools: boolean;
  allowNetwork: boolean;
  allowShell: boolean;
  maxSteps: number;
}

export const defaultPolicy: ExecutionPolicy = {
  allowTools: false,
  allowNetwork: false,
  allowShell: false,
  maxSteps: 12,
};

export function assertSafeStep(policy: ExecutionPolicy, step: number): void {
  if (step > policy.maxSteps) {
    throw new Error("Agent step limit exceeded");
  }
}
