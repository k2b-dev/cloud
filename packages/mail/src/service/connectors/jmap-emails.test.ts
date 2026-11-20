import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { JMAP_EMAIL_RESPONSE_BYTES, readJmapEmails } from "./jmap";
import { callJmap, fetchJmapSession, JMAP_CORE, JMAP_MAIL, type JmapSession, requireJmapMethodResult } from "./jmap-client";
import { JMAP_EMAIL_BODY_PROPERTIES, JMAP_EMAIL_PROPERTIES } from "./jmap-email";
import { createJmapFixture, fixtureEmail } from "./jmap-fixture";

const fixtures: ReturnType<typeof createJmapFixture>[] = [];
beforeEach(() => setSystemTime(new Date("2026-11-20T00:00:00Z")));
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  setSystemTime();
});
async function setup(count = 5, maxObjects = 2) {
  const f = createJmapFixture();
  fixtures.push(f);
  f.session.capabilities[JMAP_CORE].maxObjectsInGet = maxObjects;
  f.emails.push(...Array.from({ length: count }, (_, i) => fixtureEmail(`e${i}`)));
  const controller = new AbortController();
  const authorization = "Basic ZmljdGlvbmFsOmZpeHR1cmU=";
  const session = await fetchJmapSession({ origin: f.origin, authorization, signal: controller.signal }, f.dependencies);
  const read = (ids = f.emails.map((email) => email.id), target: JmapSession = session) =>
    readJmapEmails(target, authorization, "d333333", ids, controller.signal, f.dependencies);
  return { f, session, authorization, controller, read };
}
const batches = (f: ReturnType<typeof createJmapFixture>) =>
  f.requests.flatMap((request) => request.calls ?? []).map(([, args]) => args.ids);

test("reads bounded batches with separate notFound IDs and the exact property selection", async () => {
  const { f, read } = await setup();
  const result = await read(["e0", "gone", "e1", "e2", "e3", "e4"]);
  expect(result).toEqual({ objects: f.emails, notFoundIds: ["gone"] });
  expect(batches(f)).toEqual([
    ["e0", "gone"],
    ["e1", "e2"],
    ["e3", "e4"],
  ]);
  for (const [, args] of f.requests.flatMap((request) => request.calls ?? [])) {
    expect(args.properties).toEqual(JMAP_EMAIL_PROPERTIES);
    expect(args.bodyProperties).toEqual(JMAP_EMAIL_BODY_PROPERTIES);
  }
});

test("caps the initial batch at the existing 200-envelope budget", async () => {
  const { f, read } = await setup(201, 500);
  expect((await read()).objects).toHaveLength(201);
  expect(batches(f)).toEqual([f.emails.slice(0, 200).map((email) => email.id), ["e200"]]);
});

test("fixture selects email and nested body properties and reports absent IDs", async () => {
  const { f, session, authorization, controller } = await setup(1);
  const response = await callJmap(
    {
      session,
      authorization,
      signal: controller.signal,
      using: [JMAP_CORE, JMAP_MAIL],
      methodCalls: [
        [
          "Email/get",
          { ids: ["e0", "gone"], accountId: "d333333", properties: ["subject", "bodyStructure"], bodyProperties: ["type"] },
          "selection",
        ],
      ],
    },
    f.dependencies,
  );
  expect(requireJmapMethodResult(response, "selection", "Email/get")).toEqual({
    accountId: "d333333",
    state: "emails-state",
    list: [{ id: "e0", subject: "Example", bodyStructure: { type: "text/plain" } }],
    notFound: ["gone"],
  });
});

test("halves oversized batches repeatedly and retains the smaller size for remaining IDs", async () => {
  const { f, read } = await setup(5, 5);
  for (const email of f.emails) email.subject = "x".repeat(1_100_000);
  expect((await read()).objects).toEqual(f.emails);
  expect(batches(f)).toEqual([["e0", "e1", "e2", "e3", "e4"], ["e0", "e1"], ["e0"], ["e1"], ["e2"], ["e3"], ["e4"]]);
});

test("a single oversized object stops with a dedicated error and no silent skip", async () => {
  const { f, read } = await setup(2);
  const email = f.emails[0];
  if (!email) throw new Error("Fixture email missing");
  email.subject = "x".repeat(JMAP_EMAIL_RESPONSE_BYTES);
  await expect(read()).rejects.toMatchObject({ code: "JMAP_EMAIL_TOO_LARGE", message: "JMAP_EMAIL_TOO_LARGE" });
  expect(batches(f)).toEqual([["e0", "e1"], ["e0"]]);
});

for (const [name, list, notFound] of [
  ["missing", [], []],
  ["additional object", [fixtureEmail("extra")], ["e0"]],
  ["additional notFound", [], ["e0", "extra"]],
  ["duplicate object", [fixtureEmail("e0"), fixtureEmail("e0")], []],
  ["duplicate notFound", [], ["e0", "e0"]],
  ["overlap", [fixtureEmail("e0")], ["e0"]],
] as const) {
  test(`rejects invalid requested-ID coverage: ${name}`, async () => {
    const { f, read } = await setup(1);
    f.controls.handle = () =>
      Response.json({
        methodResponses: [["Email/get", { accountId: "d333333", state: "s", list, notFound }, "emails"]],
        sessionState: "s",
      });
    await expect(read()).rejects.toMatchObject({ code: "JMAP_INVALID_RESPONSE" });
  });
}

for (const patch of [
  { accountId: "other" },
  { list: [{ ...fixtureEmail("e0"), blobId: "bad/id" }] },
  { notFound: ["bad/id"] },
  { state: null },
]) {
  test(`rejects invalid get metadata ${JSON.stringify(patch)}`, async () => {
    const { f, read } = await setup(1);
    f.controls.handle = () =>
      Response.json({
        methodResponses: [["Email/get", { accountId: "d333333", state: "s", list: f.emails, notFound: [], ...patch }, "emails"]],
        sessionState: "s",
      });
    await expect(read()).rejects.toMatchObject({ code: "JMAP_INVALID_RESPONSE" });
  });
}

test("rejects invalid and duplicate input IDs before making any API call", async () => {
  const { f, read } = await setup();
  await expect(read(["bad/id"])).rejects.toMatchObject({ code: "JMAP_INVALID_ID" });
  await expect(read(["e0", "e0"])).rejects.toMatchObject({ code: "JMAP_INVALID_ID" });
  expect(batches(f)).toEqual([]);
  expect(await read([])).toEqual({ objects: [], notFoundIds: [] });
});

test("validates account access and mail capabilities before reading", async () => {
  const { read, session } = await setup();
  await expect(read(["e0"], { ...session, accounts: {} })).rejects.toMatchObject({ code: "JMAP_ACCOUNT" });
  await expect(read(["e0"], { ...session, capabilities: {} })).rejects.toMatchObject({ code: "JMAP_CAPABILITY" });
});

test("preserves method and request errors without retrying as oversized responses", async () => {
  const { f, read, session } = await setup();
  f.methodErrors.set("emails", "forbidden");
  await expect(read()).rejects.toMatchObject({ code: "JMAP_METHOD", methodType: "forbidden" });
  expect(batches(f)).toHaveLength(1);
  session.core.maxSizeRequest = 1;
  await expect(read()).rejects.toMatchObject({ code: "JMAP_REQUEST_LIMIT" });
  expect(batches(f)).toHaveLength(1);
});

test("aborts before reading, including an empty request", async () => {
  const { f, read, controller } = await setup();
  controller.abort();
  await expect(read()).rejects.toMatchObject({ code: "JMAP_ABORTED" });
  await expect(read([])).rejects.toMatchObject({ code: "JMAP_ABORTED" });
  expect(batches(f)).toEqual([]);
});

test("forwards cancellation during an in-flight request and never starts a subsequent batch", async () => {
  const { f, read, controller } = await setup();
  f.controls.handle = () => {
    controller.abort();
    return new Response();
  };
  await expect(read()).rejects.toMatchObject({ code: "JMAP_ABORTED" });
  expect(f.requests).toHaveLength(2);
});
