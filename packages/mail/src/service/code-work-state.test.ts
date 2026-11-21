import { expect, test } from "bun:test";
import type { sql } from "@k2b/cloud";
import type { InvocationProvenance } from "@k2b/cloud/server";
import type { MailRequestContext } from "./auth";
import { requireCodeWorkStateEligibility } from "./code-work-state";

const principal = "11111111-1111-4111-8111-111111111111";
const mailboxId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const proof: InvocationProvenance = {
  kind: "invocation",
  callingAppId: "core",
  credentialKind: "mandate",
  invocationId: "invocation",
  mandateId: "mandate",
  mandateRevision: 1,
  workloadType: "code.version",
  workloadId: "version",
  workloadRun: "run",
  workloadTrigger: {
    type: "mail.message.received",
    subject: { type: "mail.message", id: "Msg123" },
    place: { type: "mail.mailbox", id: "Box123" },
  },
};
const context = (delegation: InvocationProvenance | undefined = proof): MailRequestContext => ({
  actor: {
    kind: "service_account",
    serviceAccount: {
      id: principal,
      name: "Code",
      kind: "code",
      status: "active",
      delegatedUserId: null,
      appId: null,
      resourceType: null,
      resourceId: null,
      createdBy: null,
      createdAt: "2026-11-01T12:00:00Z",
    },
    delegatedUser: null,
    scopes: ["read", "write"],
    credentialId: null,
    credentialExpiresAt: null,
    delegation,
  },
  accessSubject: { type: "service_account", serviceAccountId: principal },
});
function database(links: string[], found = true) {
  const calls: { text: string; values: unknown[] }[] = [];
  const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });
    return Promise.resolve(
      text.includes("message_contents") ? (found ? [{ id: principal }] : []) : links.map((added_by) => ({ added_by })),
    );
  }) as unknown as typeof sql;
  return { db, calls };
}
for (const links of [["list"], ["headers", "list"]]) {
  test(`current list membership refuses a work change (${links.join(",")})`, async () => {
    const { db, calls } = database(links);
    expect(await requireCodeWorkStateEligibility({ context: context(), mailboxId, conversationIds: [conversationId], db })).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(calls[0]?.values).toEqual(["Msg123", mailboxId, "Box123"]);
    expect(calls[1]?.values).toEqual([principal, [conversationId]]);
    expect(calls[0]?.text).not.toContain("FOR SHARE");
    expect(calls[1]?.text).toContain("FOR SHARE OF link");
  });
}
test("verified normal membership keeps ordinary Code work changes available", async () => {
  const { db } = database(["headers"]);
  expect((await requireCodeWorkStateEligibility({ context: context(), mailboxId, conversationIds: [conversationId], db })).ok).toBe(true);
});
test("a missing current source message refuses the change", async () => {
  const { db } = database([], false);
  expect((await requireCodeWorkStateEligibility({ context: context(), mailboxId, conversationIds: [conversationId], db })).ok).toBe(false);
});
test("missing or partial signed Code provenance cannot become an ordinary call", async () => {
  for (const delegation of [
    undefined,
    { ...proof, workloadTrigger: undefined },
    { ...proof, workloadRun: undefined },
    { ...proof, credentialKind: "session" as const },
  ]) {
    const { db, calls } = database(["headers"]);
    const request = context();
    request.actor.delegation = delegation;
    expect((await requireCodeWorkStateEligibility({ context: request, mailboxId, conversationIds: [conversationId], db })).ok).toBe(false);
    expect(calls).toHaveLength(0);
  }
});
test("non-event Code runs carry explicit null and keep their existing behavior", async () => {
  const { db, calls } = database([]);
  expect(
    (
      await requireCodeWorkStateEligibility({
        context: context({ ...proof, workloadTrigger: null }),
        mailboxId,
        conversationIds: [conversationId],
        db,
      })
    ).ok,
  ).toBe(true);
  expect(calls).toHaveLength(0);
});

test("ordinary service-account calls keep their existing collaboration behavior", async () => {
  const request = context();
  if (request.actor.kind !== "service_account") throw new Error("Fixture requires an account");
  request.actor.serviceAccount.kind = "standalone";
  request.actor.delegation = undefined;
  const { db, calls } = database(["list"]);
  expect((await requireCodeWorkStateEligibility({ context: request, mailboxId, conversationIds: [conversationId], db })).ok).toBe(true);
  expect(calls).toHaveLength(0);
});
