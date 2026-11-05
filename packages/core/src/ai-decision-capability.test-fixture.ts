import type { DecisionQuestions, RunAiDecisionResult } from "@k2b/cloud/ai";

/** Mail triage asks category first; urgency is meaningful only within that category. */
export const decisionInputFixture = {
  task: "mail.triage",
  state: { subject: "Urgent: claim your prize", text: "Act now to receive a prize." },
  questions: {
    category: {
      type: "choice",
      instructions: "What kind of message is this?",
      criteria: { support: "Help with an existing order", spam: "Unsolicited advertising or deceptive messages" },
    },
    urgent: { type: "noul", instructions: "Does this message need urgent attention within its category?" },
    severity: { type: "score", instructions: "How severe is the reported problem?", criteria: ["No problem", "Major problem"] },
  } satisfies DecisionQuestions,
};
export const decisionResultFixture = {
  answers: {
    category: { type: "choice", choice: "spam", confidence: 0.95, probabilities: { support: 0.05, spam: 0.95 } },
    urgent: { type: "noul", probability: 0.99, value: true },
    severity: { type: "score", score: 0.1, level: 0, confidence: 0.9, probabilities: [0.9, 0.1] },
  },
  model: { id: "clef" },
  usage: { input: 40, output: 3, total: 43, cacheRead: 2, reasoning: 1 },
} satisfies RunAiDecisionResult<typeof decisionInputFixture.questions>;
