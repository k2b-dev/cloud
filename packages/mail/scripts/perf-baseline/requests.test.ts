import { expect, test } from "bun:test";
import { createMailboxInputSchema, prepareDraftSeedInputSchema, searchRequestSchema } from "../../src/contracts";
import { anchor, planLargeMailbox } from "../../test/fixtures/large-mailbox";
import { draftSeedBodies, mailboxBody, searchBodies } from "./requests";

test("all harness Mail POST bodies validate against the public route contracts", () => {
  const plan = planLargeMailbox({ seed: 20261001, anchor, messages: 20000, conversations: 3000, folders: 30 });
  const reply = plan.messages.find((m) => m.conversation === plan.shape.mediumThreadId && m.from !== "perf@example.test")!;
  // Match the JSON transport, without filling defaults before validation.
  const wire = (body: unknown): unknown => JSON.parse(JSON.stringify(body));
  createMailboxInputSchema.parse(wire(mailboxBody()));
  const drafts = draftSeedBodies(plan.senderIdentityShortId, reply);
  expect(drafts).toHaveLength(2);
  for (const body of drafts) prepareDraftSeedInputSchema.parse(wire(body));
  expect(drafts[0]!.origin).toMatchObject({ kind: "compose", input: { intent: "new" } });
  expect(drafts[1]!.origin).toMatchObject({
    kind: "compose",
    input: { intent: "reply", sourceMessageId: reply.id, conversationId: plan.shape.mediumThreadId },
  });
  const searches = searchBodies(plan.shape);
  expect(searches.map((s) => s.id)).toEqual(["search-rare", "search-common", "search-structured"]);
  for (const { body } of searches) searchRequestSchema.parse(wire(body));
});
