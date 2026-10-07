export interface EvaluationCase {
  id: string;
  task: string;
  acceptanceCriteria: string[];
  expected?: Record<string, unknown>;
  tags?: string[];
}

export interface EvaluationResult {
  caseId: string;
  passed: boolean;
  score: number;
  durationMs: number;
  details: string;
}

export interface Evaluator {
  evaluate(testCase: EvaluationCase): Promise<EvaluationResult>;
}

export class InMemoryEvaluationSuite {
  private readonly cases = new Map<string, EvaluationCase>();
  add(testCase: EvaluationCase): void { this.cases.set(testCase.id, testCase); }
  list(): EvaluationCase[] { return [...this.cases.values()]; }
}
