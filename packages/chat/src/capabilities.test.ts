import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { capabilityReviewRememberScope } from "@k2b/cloud/capabilities";
import { assertCapabilityReview, compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import type { CapabilityExecutionContext, User } from "@k2b/cloud/contracts";
import { CapabilityActionReviewDataSchema, capabilityActionPolicy } from "@k2b/cloud/contracts";
import { chatCapabilities } from "./capabilities";
import { DiscussionListInputSchema, DiscussionPostInputSchema, MessageReadInputSchema } from "./capability-contracts";
import { discussionApprovalScope, discussionReview } from "./capability-reviews";
import { authorizeDiscussion } from "./service/discussion-access";
import { discussionPreview } from "./service/discussions";
import { mockDiscussionCatalog, providerApp } from "./service/discussions.test-fixture";
import { readResource } from "./service/resource-access";

const originalOrigin = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
process.env.CLOUD_CORE_INTERNAL_ORIGIN = "http://core.test";
afterAll(() => {
  if (originalOrigin === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
  else process.env.CLOUD_CORE_INTERNAL_ORIGIN = originalOrigin;
});

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "lea",
  provider: "local",
  profile: "user",
  roles: ["user"],
  givenname: "Lea",
  sn: "Example",
  displayName: "Lea Example",
  mail: "lea@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;
const item = { type: "inventory.item", id: "22222222-2222-4222-8222-222222222222" };
const container = { ref: { type: "inventory.collection", id: "11111111-1111-4111-8111-111111111111" }, title: "Planning" };
const owner = { view: { title: "Review", permission: "read", container } };
let catalog: ReturnType<typeof mockDiscussionCatalog>;
beforeEach(() => {
  const app = providerApp("inventory", "collection", "item", "resource.fetch");
  // Resolve readers from their Type, never from a naming convention.
  catalog = mockDiscussionCatalog([app]);
});
afterEach(() => catalog.mockRestore());
const context = (data: unknown = owner): CapabilityExecutionContext => ({
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  user,
  locale: "en",
  requestId: "discussion-test",
  origin: "assistant",
  via: "assistant",
  signal: new AbortController().signal,
  query: async (input, schema) => ({
    ok: true,
    data: {
      data: schema.parse(input.capabilityId === "resource.fetch" ? data : { view: { title: container.title, permission: "write" } }),
      links: [{ rel: "open", href: "/app/inventory/resource" }],
    },
  }),
});

test("publishes exactly five item operations and a required-id message reader", () => {
  const manifest = compileCapabilityManifest("chat", chatCapabilities);
  expect(Object.keys(chatCapabilities.queries).sort()).toEqual(["discussion.list", "message.read", "notifications.read"]);
  expect(Object.keys(chatCapabilities.actions).sort()).toEqual([
    "discussion.post",
    "message.delete",
    "message.edit",
    "notifications.set",
    "thread.follow",
  ]);
  expect(manifest.types.find((type) => type.localId === "message")?.reader).toBe("message.read");
  expect(MessageReadInputSchema.safeParse({}).success).toBe(false);
  expect(chatCapabilities.actions["discussion.post"].policy).toEqual({ silent: "shared" });
  for (const id of ["discussion.post", "message.edit", "message.delete"] as const)
    expect(chatCapabilities.actions[id].idempotency).toBe("required");
});

test("bounds pages, Unicode content and previews, rejects provenance and occurrence input", () => {
  expect(DiscussionListInputSchema.safeParse({ ref: item, limit: 21 }).success).toBe(false);
  expect(DiscussionPostInputSchema.safeParse({ ref: item, body: "ok", via: "assistant" }).success).toBe(false);
  expect(DiscussionPostInputSchema.safeParse({ ref: item, body: "ok", recurrenceId: "2026-10-28" }).success).toBe(false);
  expect(DiscussionPostInputSchema.safeParse({ ref: item, body: "🦋".repeat(20_000) }).success).toBe(true);
  expect(DiscussionPostInputSchema.safeParse({ ref: item, body: "🦋".repeat(20_001) }).success).toBe(false);
  expect(discussionPreview("🦋".repeat(301))).toEqual({ preview: "🦋".repeat(300), previewTruncated: true });
  expect(discussionPreview("a".repeat(300)).previewTruncated).toBe(false);
  expect(discussionPreview(null)).toEqual({ preview: "", previewTruncated: false });
});

test("fresh standard item and container readers supply only the exact authorized resources", async () => {
  const c = context();
  const query = c.query!;
  const calls: unknown[] = [];
  c.query = async (input, schema) => {
    calls.push(input);
    return query(input, schema);
  };
  const access = await authorizeDiscussion(item, c, true);
  expect(access.ok).toBe(true);
  expect(calls).toHaveLength(2);
  expect(calls).toMatchObject([
    { appId: "inventory", capabilityId: "resource.fetch", input: { id: item.id } },
    { appId: "inventory", capabilityId: "collection.read", input: { id: container.ref.id } },
  ]);
  if (!access.ok) throw new Error("Expected authorized item");
  expect(access.data.context.accessSubject).toBe(c.accessSubject);
  expect(access.data.context.actor).toBe(c.actor);
  expect(access.data.context.caller?.authority).toBe(c.authority);
  expect((await readResource(access.data.context, container.ref))?.permission).toBe("write");
  expect(await readResource(access.data.context, { type: "inventory.item", id: "Other1" })).toBeNull();
  expect(await readResource(access.data.context, { type: "inventory.collection", id: "Other2" })).toBeNull();
  await authorizeDiscussion(item, c);
  expect(calls.length).toBe(4);
});

test("fails closed on unavailable, denied, malformed and moved owner results", async () => {
  for (const status of [403, 404, 500] as const) {
    const c = context();
    c.query = async () => ({ ok: false, error: { code: "DENIED", message: "private provider detail", status } });
    const access = await authorizeDiscussion(item, c);
    expect(access.ok).toBe(false);
    if (!access.ok) {
      expect(access.error.status).toBe(status === 500 ? 503 : 404);
      expect(access.error.message).not.toContain("private provider detail");
    }
  }
  const absent = context();
  delete absent.query;
  expect((await authorizeDiscussion(item, absent)).ok).toBe(false);
  const broken = context();
  broken.query = async () => {
    throw new Error("offline");
  };
  expect((await authorizeDiscussion(item, broken)).ok).toBe(false);
  for (const data of [
    {},
    { view: { ...owner.view, container: undefined } },
    { view: { ...owner.view, container: { ...container, ref: { ...container.ref, type: "supplies.collection" } } } },
  ])
    expect((await authorizeDiscussion(item, context(data))).ok).toBe(false);
  expect((await authorizeDiscussion({ ...item, type: container.ref.type }, context())).ok).toBe(false);
});

test("scope ceilings survive user delegation and a reader grant cannot authorize a write", async () => {
  const c = context();
  c.authority = { actor: c.actor, accessSubject: c.accessSubject, credentialKind: "oauth", scopes: ["read"] };
  expect((await authorizeDiscussion(item, c)).ok).toBe(true);
  expect((await authorizeDiscussion(item, c, true)).ok).toBe(false);
  const readOnly = context();
  const query = readOnly.query!;
  readOnly.query = async (input, schema) =>
    input.capabilityId === "collection.read"
      ? { ok: true, data: { data: schema.parse({ view: { title: "Planning", permission: "read" } }) } }
      : query(input, schema);
  expect((await authorizeDiscussion(item, readOnly, true)).ok).toBe(false);
});

test("message entry points check credential scopes before looking up a message", async () => {
  const c = context();
  let queried = false;
  c.query = async () => {
    queried = true;
    throw new Error("Must not read an owner");
  };
  c.authority = { actor: c.actor, accessSubject: c.accessSubject, credentialKind: "oauth", scopes: [] };
  const deniedRead = await chatCapabilities.queries["message.read"].run({ id: "Missing001" }, c);
  expect(!deniedRead.ok && deniedRead.error.status).toBe(403);
  c.authority = { ...c.authority, scopes: ["read"] };
  const deniedReview = await chatCapabilities.actions["message.edit"].review({ id: "Missing002", revision: 0, body: "Correction" }, c);
  expect(!deniedReview.ok && deniedReview.error.status).toBe(403);
  const delegated = context();
  delegated.actor = {
    ...delegated.actor,
    delegation: { kind: "invocation", credentialKind: "oauth", callingAppId: "core", invocationId: "test" },
  };
  expect((await authorizeDiscussion(item, delegated)).ok).toBe(false);
  expect(queried).toBe(false);
});

test("all discussion approval operations preserve a maximum-size message in full review content", async () => {
  const body = "🦋".repeat(20_000);
  for (const locale of ["en", "de"])
    for (const operation of ["post", "edit", "delete"] as const) {
      const review = discussionReview(operation, item, "Review", body, locale, operation === "post" ? undefined : 0);
      expect(CapabilityActionReviewDataSchema.parse(review)).toEqual(review);
      const manifest = compileCapabilityManifest("chat", chatCapabilities);
      const id = operation === "post" ? "discussion.post" : `message.${operation}`;
      const action = manifest.actions.find((action) => action.localId === id)!;
      assertCapabilityReview(review, {
        policy: capabilityActionPolicy(manifest, id),
        approval: action.approval,
        queries: manifest.queries,
        validateQueryInput: () => false,
        locales: ["en", "de"],
      });
      expect(review.content?.body).toBe(body);
      const { content: _content, ...compact } = review;
      expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(32 * 1024);
    }
  const actualPost = await chatCapabilities.actions["discussion.post"].review({ ref: item, body }, context());
  expect(actualPost.ok).toBe(true);
  if (actualPost.ok) {
    const parsed = CapabilityActionReviewDataSchema.parse(actualPost.data);
    expect("content" in parsed && parsed.content?.body).toBe(body);
    const manifest = compileCapabilityManifest("chat", chatCapabilities);
    const approval = manifest.actions.find((action) => action.localId === "discussion.post")?.approval;
    expect(capabilityReviewRememberScope(actualPost.data, approval)).toBe(discussionApprovalScope(container.ref));
  }
});

test("container approval scopes fit opaque IDs without collisions from truncation", () => {
  const first = { type: "inventory.collection", id: "a".repeat(511) + "1" };
  const second = { ...first, id: "a".repeat(511) + "2" };
  const review = { ...discussionReview("post", item, "Review", "Hello"), scope: discussionApprovalScope(first) };
  expect(CapabilityActionReviewDataSchema.parse(review)).toEqual(review);
  expect(discussionApprovalScope(first)).toBe(discussionApprovalScope({ ...first }));
  expect(discussionApprovalScope(first)).not.toBe(discussionApprovalScope(second));
  expect(discussionApprovalScope(first)).not.toBe(discussionApprovalScope({ ...first, type: "supplies.collection" }));
  expect(DiscussionPostInputSchema.safeParse({ ref: { ...item, id: "a".repeat(512) }, body: "ok" }).success).toBe(true);
  expect(DiscussionPostInputSchema.safeParse({ ref: { ...item, id: "a".repeat(513) }, body: "ok" }).success).toBe(false);
});

test("container denial and cancellation never fall back to another authority", async () => {
  for (const status of [403, 404, 500] as const) {
    const c = context();
    const query = c.query!;
    const calls: string[] = [];
    c.query = async (input, schema) => {
      calls.push(input.capabilityId);
      return input.capabilityId === "collection.read"
        ? { ok: false, error: { code: "DENIED", message: "private", status } }
        : query(input, schema);
    };
    const access = await authorizeDiscussion(item, c, true);
    expect(!access.ok && access.error.status).toBe(status === 500 ? 503 : 404);
    expect(calls).toEqual(["resource.fetch", "collection.read"]);
  }
  const c = context();
  const controller = new AbortController();
  c.signal = controller.signal;
  controller.abort();
  let queried = false;
  c.query = async () => {
    queried = true;
    throw new Error("Cancelled");
  };
  expect((await authorizeDiscussion(item, c, true)).ok).toBe(false);
  expect(queried).toBe(false);
});
