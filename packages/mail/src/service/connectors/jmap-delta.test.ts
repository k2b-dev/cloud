import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { JMAP_DISCOVERY_PAGES, JMAP_EMAIL_RESPONSE_BYTES } from "./jmap";
import { fetchJmapSession, JMAP_CORE, type JmapInvocation } from "./jmap-client";
import { readJmapEmailDelta, readJmapMailboxDelta } from "./jmap-delta";
import { createJmapFixture, fixtureEmail, fixtureMailbox } from "./jmap-fixture";

const fixtures: ReturnType<typeof createJmapFixture>[] = [];
beforeEach(() => setSystemTime(new Date("2026-11-20T00:00:00Z")));
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  setSystemTime();
});
async function setup(maxCalls = 3, maxObjects = 200) {
  const f = createJmapFixture();
  fixtures.push(f);
  f.session.capabilities[JMAP_CORE].maxCallsInRequest = maxCalls;
  f.session.capabilities[JMAP_CORE].maxObjectsInGet = maxObjects;
  const controller = new AbortController();
  const authorization = "Basic fictional-unused";
  const session = await fetchJmapSession({ origin: f.origin, authorization, signal: controller.signal }, f.dependencies);
  return {
    f,
    session,
    controller,
    emails: (state = "Email:0") => readJmapEmailDelta(session, authorization, "d333333", state, controller.signal, f.dependencies),
    mailboxes: (state = "Mailbox:0") => readJmapMailboxDelta(session, authorization, "d333333", state, controller.signal, f.dependencies),
  };
}
function seed(f: ReturnType<typeof createJmapFixture>) {
  f.emails.push(fixtureEmail("created"), fixtureEmail("updated"));
  f.journal.Email.push({ id: "created", kind: "created" }, { id: "updated", kind: "updated" }, { id: "destroyed", kind: "destroyed" });
}

for (const maxCalls of [1, 2, 3]) {
  test(`reads a complete email delta at maxCallsInRequest=${maxCalls} and ignores newer get state`, async () => {
    const { f, emails } = await setup(maxCalls);
    seed(f);
    f.controls.getState = "newer:/opaque";
    const delta = await emails();
    expect(delta).toEqual({
      oldState: "Email:0",
      newState: "Email:3",
      hasMoreChanges: false,
      createdIds: ["created"],
      updatedIds: ["updated"],
      destroyedIds: ["destroyed"],
      notFoundIds: [],
      objects: f.emails,
    });
    const requests = f.requests.filter((request) => request.calls);
    expect(requests.map((request) => request.calls?.length)).toEqual(maxCalls === 3 ? [3] : [1, 1]);
    if (maxCalls === 3)
      expect(requests[0]?.calls?.slice(1).map(([, args]) => args["#ids"])).toEqual([
        { resultOf: "changes", name: "Email/changes", path: "/created" },
        { resultOf: "changes", name: "Email/changes", path: "/updated" },
      ]);
  });

  test(`reports notFound race at maxCallsInRequest=${maxCalls}`, async () => {
    const { f, emails } = await setup(maxCalls);
    seed(f);
    f.controls.afterChanges = () => {
      f.emails.splice(0, 1);
      f.journal.Email.push({ id: "created", kind: "destroyed" });
    };
    expect(await emails()).toMatchObject({ notFoundIds: ["created"], objects: [fixtureEmail("updated")], newState: "Email:3" });
  });
}

for (const kind of ["Email", "Mailbox"] as const) {
  test(`${kind}: continues bounded pages and permits an empty unchanged page`, async () => {
    const { f, emails, mailboxes } = await setup(3, 1);
    const read = kind === "Email" ? emails : mailboxes;
    f.journal[kind].push({ id: "a", kind: "created" }, { id: "b", kind: "updated" }, { id: "gone", kind: "destroyed" });
    f.emails.push(fixtureEmail("a"), fixtureEmail("b"));
    let state = `${kind}:0`;
    for (let index = 1; index <= 3; index++) {
      const delta = await read(state);
      expect(delta.newState).toBe(`${kind}:${index}`);
      expect(delta.hasMoreChanges).toBe(index < 3);
      state = delta.newState;
    }
    expect(await read(state)).toMatchObject({ oldState: state, newState: state, hasMoreChanges: false });
  });

  for (const [methodType, cause] of [
    ["invalidArguments", "state_rejected"],
    ["cannotCalculateChanges", "cannot_calculate"],
  ]) {
    test(`${kind}: changes ${methodType} outranks dependent get errors`, async () => {
      const { f, emails, mailboxes } = await setup();
      if (!methodType) throw new Error("missing fixture error");
      f.methodErrors.set(`${kind}/changes`, methodType);
      await expect((kind === "Email" ? emails : mailboxes)()).rejects.toMatchObject({ code: "JMAP_RECONCILIATION_REQUIRED", cause });
    });
  }

  test(`${kind}: rejects unknown stored state and propagates independent method errors`, async () => {
    const { f, emails, mailboxes } = await setup();
    const read = kind === "Email" ? emails : mailboxes;
    await expect(read("rejected:state")).rejects.toMatchObject({ code: "JMAP_RECONCILIATION_REQUIRED", cause: "state_rejected" });
    f.methodErrors.set(`${kind}/changes`, "forbidden");
    await expect(read()).rejects.toMatchObject({ code: "JMAP_METHOD", methodType: "forbidden" });
    f.methodErrors.clear();
    f.journal[kind].push({ id: "a", kind: "created" });
    f.methodErrors.set(`${kind}/get`, "invalidArguments");
    await expect(read()).rejects.toMatchObject({ code: "JMAP_METHOD", methodType: "invalidArguments" });
  });

  for (const patch of [
    { accountId: "other" },
    { oldState: "wrong" },
    { newState: "x".repeat(1_025) },
    { created: ["a", "a"] },
    { updated: ["a", "a"] },
    { destroyed: ["a", "a"] },
    { created: ["a"], updated: ["a"], destroyed: ["a"] },
    { created: ["bad/id"] },
    { created: ["a", "b", "c"] },
    { hasMoreChanges: true, newState: `${kind}:0` },
  ]) {
    test(`${kind}: rejects invalid changes ${Object.keys(patch).join(",")}`, async () => {
      const { f, emails, mailboxes } = await setup(3, 2);
      f.controls.transform = ([name, args, id]) => [name, name === `${kind}/changes` ? { ...args, ...patch } : args, id];
      await expect((kind === "Email" ? emails : mailboxes)()).rejects.toMatchObject({ code: "JMAP_INVALID_RESPONSE" });
    });
  }

  for (const invalid of ["extra", "duplicate", "both", "missing", "account", "state", "call", "method"]) {
    test(`${kind}: rejects ${invalid} get coverage or correlation`, async () => {
      const { f, emails, mailboxes } = await setup();
      f.journal[kind].push({ id: "a", kind: "created" });
      f.emails.push(fixtureEmail("a"));
      const object = kind === "Email" ? fixtureEmail : (id: string) => fixtureMailbox(id, "Example");
      f.controls.transform = ([name, args, id]) => {
        if (name !== `${kind}/get`) return [name, args, id];
        const patch =
          invalid === "extra"
            ? { list: [object("a"), object("extra")] }
            : invalid === "duplicate"
              ? { list: [object("a"), object("a")] }
              : invalid === "both"
                ? { list: [object("a")], notFound: ["a"] }
                : invalid === "missing"
                  ? { list: [], notFound: [] }
                  : invalid === "account"
                    ? { accountId: "other" }
                    : invalid === "state"
                      ? { state: "x".repeat(1_025) }
                      : {};
        return [invalid === "method" ? "Other/get" : name, { ...args, ...patch }, invalid === "call" ? "unexpected" : id];
      };
      await expect((kind === "Email" ? emails : mailboxes)()).rejects.toMatchObject({ code: "JMAP_INVALID_RESPONSE" });
    });
  }

  test(`${kind}: aborts before and between calls`, async () => {
    const first = await setup();
    first.controller.abort();
    await expect((kind === "Email" ? first.emails : first.mailboxes)()).rejects.toMatchObject({ code: "JMAP_ABORTED" });
    expect(first.f.requests.filter((request) => request.calls)).toHaveLength(0);
    const second = await setup(1);
    second.f.journal[kind].push({ id: "a", kind: "created" });
    second.f.controls.afterChanges = () => second.controller.abort();
    await expect((kind === "Email" ? second.emails : second.mailboxes)()).rejects.toMatchObject({ code: "JMAP_ABORTED" });
  });
}

test("fixture coalesces create-update-destroy without inventing an email", async () => {
  const { f, emails } = await setup();
  f.journal.Email.push({ id: "gone", kind: "created" }, { id: "gone", kind: "updated" }, { id: "gone", kind: "destroyed" });
  expect(await emails()).toMatchObject({ newState: "Email:3", createdIds: [], updatedIds: [], destroyedIds: [], objects: [] });
});

test("combined response budget falls back and bounded get halves its batch", async () => {
  const { f, emails } = await setup();
  for (const id of ["a", "b", "c"]) {
    f.emails.push({ ...fixtureEmail(id), subject: "x".repeat(Math.floor(JMAP_EMAIL_RESPONSE_BYTES / 2)) });
    f.journal.Email.push({ id, kind: "created" });
  }
  expect((await emails()).objects.map((email) => email.id)).toEqual(["a", "b", "c"]);
  expect(
    f.requests.filter((request) => request.calls).map((request) => request.calls?.map(([name, args]) => [name, args.ids ?? null])),
  ).toEqual([
    [
      ["Email/changes", null],
      ["Email/get", null],
      ["Email/get", null],
    ],
    [["Email/changes", null]],
    [["Email/get", ["a", "b", "c"]]],
    [["Email/get", ["a"]]],
    [["Email/get", ["b"]]],
    [["Email/get", ["c"]]],
  ]);
});

test("a single oversized email fails visibly without returning a checkpoint", async () => {
  const { f, emails } = await setup();
  f.emails.push({ ...fixtureEmail("a"), subject: "x".repeat(JMAP_EMAIL_RESPONSE_BYTES) });
  f.journal.Email.push({ id: "a", kind: "created" });
  await expect(emails()).rejects.toMatchObject({ code: "JMAP_EMAIL_TOO_LARGE" });
});

test("mailbox rename and reparent load absent ancestors and preserve stable identity", async () => {
  const { f, mailboxes } = await setup();
  f.journal.Mailbox.push({ id: "c", kind: "updated" }, { id: "gone", kind: "destroyed" });
  const before = await mailboxes();
  f.mailboxes.splice(2, 1, fixtureMailbox("c", "Renamed", "a"));
  f.mailboxes.push(fixtureMailbox("new", "New", "b"));
  f.journal.Mailbox.push({ id: "new", kind: "created" });
  const after = await mailboxes();
  expect(before.updated[0]?.path).toBe("Projects/Example");
  expect(after.updated[0]).toMatchObject({
    mailboxId: "c",
    parentMailboxId: "a",
    path: "Inbox/Renamed",
    stableKey: before.updated[0]?.stableKey,
  });
  expect(after.created.map((folder) => folder.mailboxId)).toEqual(["new"]);
  expect(after.destroyedIds).toEqual(["gone"]);
  expect(
    f.requests
      .flatMap((request) => request.calls ?? [])
      .filter(([name]) => name === "Mailbox/get")
      .map(([, args]) => args.ids),
  ).toEqual([["c"], ["b"], ["new", "c"], ["a", "b"]]);
});

test("counter-only updates skip get but created mailboxes still load", async () => {
  const { f, mailboxes } = await setup();
  f.controls.updatedProperties = ["totalEmails", "unreadEmails", "totalThreads", "unreadThreads"];
  f.journal.Mailbox.push({ id: "a", kind: "updated" });
  expect(await mailboxes()).toMatchObject({ updated: [], newState: "Mailbox:1" });
  expect(f.requests.flatMap((request) => request.calls ?? []).map(([name]) => name)).toEqual(["Mailbox/changes"]);
  f.journal.Mailbox.push({ id: "b", kind: "created" });
  expect(await mailboxes()).toMatchObject({ created: [expect.objectContaining({ mailboxId: "b" })], updated: [] });
  f.controls.updatedProperties = ["totalEmails", "name"];
  expect((await mailboxes()).updated.map((folder) => folder.mailboxId)).toEqual(["a"]);
});

test("a disappearing mailbox is notFound, but a missing parent or cycle fails", async () => {
  const { f, mailboxes } = await setup();
  f.journal.Mailbox.push({ id: "gone", kind: "created" });
  expect(await mailboxes()).toMatchObject({ created: [], notFoundIds: ["gone"] });
  f.journal.Mailbox.splice(0, 1, { id: "c", kind: "updated" });
  f.mailboxes.splice(1, 1);
  await expect(mailboxes()).rejects.toMatchObject({ code: "JMAP_FOLDER_TREE" });
  f.mailboxes.push(fixtureMailbox("b", "Cycle", "c"));
  await expect(mailboxes()).rejects.toMatchObject({ code: "JMAP_FOLDER_TREE" });
});

test("mailbox name budget and ancestor request budget match discovery", async () => {
  const { f, mailboxes } = await setup(3, 1);
  f.journal.Mailbox.push({ id: "a", kind: "updated" });
  f.mailboxes.splice(0, 1, fixtureMailbox("a", "x".repeat(1_001)));
  await expect(mailboxes()).rejects.toMatchObject({ code: "JMAP_DISCOVERY_LIMIT" });
  f.controls.transform = ([name, args, id]): JmapInvocation => {
    if (name !== "Mailbox/get") return [name, args, id];
    const count = f.requests.filter((request) => request.calls?.some(([method]) => method === "Mailbox/get")).length - 1;
    return [
      name,
      { ...args, list: [fixtureMailbox(count === 1 ? "a" : `parent${count - 1}`, "Parent", `parent${count}`)], notFound: [] },
      id,
    ];
  };
  await expect(mailboxes()).rejects.toMatchObject({ code: "JMAP_DISCOVERY_LIMIT" });
  expect(f.requests.filter((request) => request.calls?.some(([name]) => name === "Mailbox/get"))).toHaveLength(JMAP_DISCOVERY_PAGES + 1);
});

test("email changes cap maxChanges at the shared envelope batch size", async () => {
  const { f, emails } = await setup(3, 500);
  for (let index = 0; index < 201; index++) f.journal.Email.push({ id: `gone${index}`, kind: "destroyed" });
  expect(await emails()).toMatchObject({ hasMoreChanges: true, newState: "Email:200" });
  expect(f.requests.flatMap((request) => request.calls ?? []).find(([name]) => name === "Email/changes")?.[1].maxChanges).toBe(200);
});

test("input states are opaque and bounded; invalid accounts fail before network work", async () => {
  const { f, session, controller, emails } = await setup();
  await expect(emails("x".repeat(1_025))).rejects.toMatchObject({ code: "JMAP_INVALID_RESPONSE" });
  for (const read of [readJmapEmailDelta, readJmapMailboxDelta]) {
    await expect(read(session, "Basic fictional-unused", "bad/account", "opaque", controller.signal, f.dependencies)).rejects.toMatchObject(
      { code: "JMAP_INVALID_ID" },
    );
    await expect(read(session, "Basic fictional-unused", "absent", "opaque", controller.signal, f.dependencies)).rejects.toMatchObject({
      code: "JMAP_ACCOUNT",
    });
  }
  expect(f.requests.filter((request) => request.calls)).toHaveLength(0);
});

// RFC 8620 §5.2 lets a server repeat an id across created, updated and destroyed.
const emailOverlaps = [
  {
    form: "created and updated",
    changes: { created: ["x"], updated: ["x"], destroyed: [] },
    remote: ["x"],
    delta: { createdIds: ["x"], updatedIds: [], destroyedIds: [], notFoundIds: [] },
    objects: ["x"],
  },
  {
    form: "updated and destroyed while get reports notFound",
    changes: { created: [], updated: ["x"], destroyed: ["x"] },
    remote: [],
    delta: { createdIds: [], updatedIds: [], destroyedIds: ["x"], notFoundIds: [] },
    objects: [],
  },
  {
    form: "updated and destroyed while get still returns the email",
    changes: { created: [], updated: ["x"], destroyed: ["x"] },
    remote: ["x"],
    delta: { createdIds: [], updatedIds: [], destroyedIds: ["x"], notFoundIds: [] },
    objects: [],
  },
  {
    form: "created and destroyed",
    changes: { created: ["x"], updated: [], destroyed: ["x"] },
    remote: [],
    delta: { createdIds: [], updatedIds: [], destroyedIds: ["x"], notFoundIds: [] },
    objects: [],
  },
  {
    form: "every form beside plain ids",
    changes: { created: ["new", "both", "flash", "lost"], updated: ["edit", "both", "gone"], destroyed: ["old", "gone", "flash"] },
    remote: ["new", "both", "edit", "gone"],
    delta: { createdIds: ["new", "both", "lost"], updatedIds: ["edit"], destroyedIds: ["old", "gone", "flash"], notFoundIds: ["lost"] },
    objects: ["new", "both", "edit"],
  },
];

for (const maxCalls of [1, 3]) {
  for (const overlap of emailOverlaps) {
    test(`email changes accept ${overlap.form} at maxCallsInRequest=${maxCalls}`, async () => {
      const { f, emails } = await setup(maxCalls);
      f.emails.push(...overlap.remote.map((id) => fixtureEmail(id)));
      f.controls.transform = ([name, args, id]) => [name, name === "Email/changes" ? { ...args, ...overlap.changes } : args, id];
      const delta = await emails();
      expect(delta).toEqual({
        oldState: "Email:0",
        newState: "Email:0",
        hasMoreChanges: false,
        ...overlap.delta,
        objects: overlap.objects.map((id) => fixtureEmail(id)),
      });
      const listed = [...delta.createdIds, ...delta.updatedIds];
      expect(new Set([...listed, ...delta.destroyedIds]).size).toBe(listed.length + delta.destroyedIds.length);
      expect([...delta.objects.map((email) => email.id), ...delta.notFoundIds].sort()).toEqual([...listed].sort());
      const gets = f.requests.flatMap((request) => request.calls ?? []).filter(([name]) => name === "Email/get");
      if (maxCalls === 3)
        expect(gets.map(([, args]) => args["#ids"])).toEqual([
          { resultOf: "changes", name: "Email/changes", path: "/created" },
          { resultOf: "changes", name: "Email/changes", path: "/updated" },
        ]);
      else expect(gets.map(([, args]) => args.ids)).toEqual(listed.length ? [listed] : []);
    });
  }
}

for (const overlap of [
  {
    form: "created and updated",
    changes: { created: ["c"], updated: ["c"], destroyed: [] },
    created: ["c"],
    updated: [],
    gets: [["c"], ["b"]],
  },
  {
    form: "updated and destroyed",
    changes: { created: [], updated: ["a", "gone"], destroyed: ["gone"] },
    created: [],
    updated: ["a"],
    gets: [["a"]],
  },
  { form: "created and destroyed", changes: { created: ["gone"], updated: [], destroyed: ["gone"] }, created: [], updated: [], gets: [] },
  {
    form: "every form beside plain ids",
    changes: { created: ["b", "c", "flash"], updated: ["a", "c", "gone"], destroyed: ["old", "gone", "flash"] },
    created: ["b", "c"],
    updated: ["a"],
    gets: [["b", "c", "a"]],
  },
]) {
  test(`mailbox changes accept ${overlap.form} and never get a destroyed id`, async () => {
    const { f, mailboxes } = await setup();
    f.controls.transform = ([name, args, id]) => [name, name === "Mailbox/changes" ? { ...args, ...overlap.changes } : args, id];
    const delta = await mailboxes();
    expect(delta.created.map((folder) => folder.mailboxId).sort()).toEqual(overlap.created);
    expect(delta.updated.map((folder) => folder.mailboxId)).toEqual(overlap.updated);
    expect(delta.destroyedIds).toEqual(overlap.changes.destroyed);
    expect(delta.notFoundIds).toEqual([]);
    expect(
      f.requests
        .flatMap((request) => request.calls ?? [])
        .filter(([name]) => name === "Mailbox/get")
        .map(([, args]) => args.ids),
    ).toEqual(overlap.gets);
  });
}
