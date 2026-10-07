export interface ReviewResult {
  approved: boolean;
  reason: string;
}

export class Reviewer {
  async review(task: string, output: string): Promise<ReviewResult> {
    if (!output.trim()) return { approved: false, reason: "The model returned an empty result." };

    const looksIncomplete = /I can't|cannot complete|not implemented|TODO/i.test(output);
    if (looksIncomplete) {
      return { approved: false, reason: "The result indicates incomplete work." };
    }

    return {
      approved: true,
      reason: `Result produced for task: ${task.slice(0, 120)}`,
    };
  }
}
