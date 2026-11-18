import type { ApprovalHandler } from "./approval-broker.js";
export type { ApprovalRequest, ApprovalHandler, ApprovalDecision, ApprovalRecord, ApprovalDecisionStore } from "./approval-broker.js";
export { ApprovalBroker, InMemoryApprovalDecisionStore } from "./approval-broker.js";
/**
 * Explicit development-only helper. Production must use a real approval
 * mechanism bound to the displayed action hash; this helper fails closed.
 */
export const approveAll: ApprovalHandler = async () => {
  if (process.env.NODE_ENV === "production" || process.env.SOFIA_ENV === "production") return false;
  return true;
};
