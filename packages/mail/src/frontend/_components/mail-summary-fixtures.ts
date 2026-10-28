import type { ConversationContentSummary } from "../../service/conversation-summary";

/** A summary state for tests and harnesses: a person-written text unless the overrides say otherwise. */
export const summaryState = (overrides: Partial<ConversationContentSummary> = {}): ConversationContentSummary => ({
  summary: null,
  summaryRevision: 1,
  conversationRevision: 1,
  source: overrides.summary ? "person" : null,
  author: null,
  ai: false,
  generatedAt: null,
  coveredMessageCount: null,
  truncated: false,
  nextStep: null,
  newMessagesSince: 0,
  status: "idle",
  failure: null,
  limit: null,
  allowance: null,
  canGenerate: false,
  ...overrides,
});
