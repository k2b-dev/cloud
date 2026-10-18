import type { CreateMailboxInput, PrepareDraftSeedInput, SearchRequest } from "../../src/contracts";
import type { LargeMailboxPlan } from "../../test/fixtures/large-mailbox";

export const mailboxBody = () =>
  ({ name: "Mailbox performance baseline", description: "Disposable deterministic mailbox" }) satisfies CreateMailboxInput;

export function draftSeedBodies(senderIdentityId: string, reply: LargeMailboxPlan["messages"][number]) {
  return [
    {
      origin: {
        kind: "compose",
        input: {
          senderIdentityId,
          to: [{ address: "recipient@example.test" }],
          cc: [],
          bcc: [],
          subject: "Performance compose",
          body: "Draft fixture",
          intent: "new",
        },
      },
    },
    {
      origin: {
        kind: "compose",
        input: {
          senderIdentityId,
          to: [{ address: reply.from }],
          cc: [],
          bcc: [],
          subject: `Re: ${reply.subject}`,
          body: "Reply fixture",
          intent: "reply",
          sourceMessageId: reply.id,
          conversationId: reply.conversation,
        },
      },
    },
  ] satisfies PrepareDraftSeedInput[];
}

export function searchBodies(shape: LargeMailboxPlan["shape"]) {
  return [
    {
      id: "search-rare",
      body: { expression: { type: "text", field: "any", query: shape.rareWord, match: "words" }, sort: "relevance", limit: 50 },
    },
    {
      id: "search-common",
      body: { expression: { type: "text", field: "any", query: shape.commonWord, match: "words" }, sort: "relevance", limit: 50 },
    },
    {
      id: "search-structured",
      body: {
        expression: {
          type: "and",
          expressions: [
            { type: "text", field: "from", query: shape.structuredTarget.from, match: "exact" },
            { type: "text", field: "body", query: shape.rareWord, match: "words" },
          ],
        },
        sort: "relevance",
        limit: 50,
      },
    },
  ] satisfies { id: string; body: SearchRequest }[];
}
