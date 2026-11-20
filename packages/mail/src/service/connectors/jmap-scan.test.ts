import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { JMAP_DISCOVERY_PAGES, JMAP_EMAIL_RESPONSE_BYTES } from "./jmap";
import { callJmap, fetchJmapSession, JMAP_CORE, JMAP_MAIL, type JmapInvocation, requireJmapMethodResult } from "./jmap-client";
import { createJmapFixture, fixtureEmail, fixtureMailbox } from "./jmap-fixture";
import {
  type JmapScanPage,
  type JmapScanPageStep,
  type JmapScanStep,
  jmapEmailExistenceLimit,
  jmapScanStepSchema,
  readJmapAccountStart,
  readJmapEmailExistence,
  readJmapScanPage,
} from "./jmap-scan";

const fixtures: ReturnType<typeof createJmapFixture>[] = [];
beforeEach(() => setSystemTime(new Date("2026-11-20T00:00:00Z")));
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  setSystemTime();
});
async function setup(maxObjects = 3, maxCalls = 16) {
  const f = createJmapFixture();
  fixtures.push(f);
  f.session.capabilities[JMAP_CORE].maxObjectsInGet = maxObjects;
  f.session.capabilities[JMAP_CORE].maxCallsInRequest = maxCalls;
  const controller = new AbortController();
  const authorization = "Basic fictional-unused";
  const session = await fetchJmapSession({ origin: f.origin, authorization, signal: controller.signal }, f.dependencies);
  return {
    f,
    session,
    page: (step: JmapScanPageStep) => readJmapScanPage(session, authorization, "d333333", step, controller.signal, f.dependencies),
    exists: (ids: string[]) => readJmapEmailExistence(session, authorization, "d333333", ids, controller.signal, f.dependencies),
    start: () => readJmapAccountStart(session, authorization, "d333333", controller.signal, f.dependencies),
  };
}
// Fictional seconds of one minute; fractions only where a test needs them.
const at = (second: string) => `2026-11-19T10:00:${second}Z`;
const mail = (id: string, second: string) => ({ ...fixtureEmail(id), receivedAt: at(second) });
const ids = (page: JmapScanPage) => (page.kind === "page" ? page.objects.map((email) => email.id) : []);
const query = (before: string | null = null): JmapScanPageStep => ({ kind: "query", before: before && at(before) });
const bucket = (second: string, position = 0, queryState: string | null = null): JmapScanPageStep => ({
  kind: "bucket",
  second: at(second),
  position,
  queryState,
});
const posted = (f: ReturnType<typeof createJmapFixture>) => f.requests.flatMap((request) => request.calls ?? []);
/** Replace one method response's arguments; everything else stays real. */
const patch = (
  f: ReturnType<typeof createJmapFixture>,
  method: string,
  change: (args: Record<string, unknown>) => Record<string, unknown>,
) => {
  f.controls.transform = ([name, args, id]: JmapInvocation): JmapInvocation => [name, name === method ? change(args) : args, id];
};

/** Walk like the later state commit: keep `next`, and forget a bucket's reads when it restarts. */
async function walk(read: (step: JmapScanPageStep) => Promise<JmapScanPage>, between: Array<() => void> = []) {
  let step: JmapScanStep = query();
  const reads: string[] = [];
  let bucketReads: string[] = [];
  const trace: Array<{ step: JmapScanStep; result: JmapScanPage }> = [];
  for (let turn = 0; step.kind !== "verify"; turn++) {
    if (turn > 50) throw new Error("walk: no progress");
    const result = await read(step);
    trace.push({ step, result });
    between[turn]?.();
    if (result.kind === "restart") {
      if (step.kind === "bucket") for (const id of bucketReads) reads.splice(reads.lastIndexOf(id), 1);
      bucketReads = [];
    } else {
      reads.push(...ids(result));
      bucketReads = step.kind === "bucket" && result.next.kind === "bucket" ? [...bucketReads, ...ids(result)] : [];
    }
    step = result.next;
  }
  return { reads, trace };
}

describe("readJmapScanPage", () => {
  test("plan race with N=3: every unchanged message is read exactly once", async () => {
    const { f, page } = await setup(3);
    const start = [
      ["A", "10"],
      ["B", "09"],
      ["C", "08"],
      ["D", "08"],
      ["E", "08"],
      ["F", "08"],
      ["G", "07"],
      ["H", "06"],
    ] as const;
    f.emails.push(...start.map(([id, second]) => mail(id, second)));
    const remove = (id: string) =>
      f.emails.splice(
        f.emails.findIndex((email) => email.id === id),
        1,
      );
    const { reads, trace } = await walk(page, [
      () => {
        remove("A");
        f.emails.push(mail("X", "11"), mail("Y", "05"));
      },
      () => undefined,
      () => {
        remove("C");
        f.emails.push(mail("Z", "08"));
      },
    ]);
    expect(trace.map(({ step, result }) => [step, result.kind, ids(result), result.next])).toEqual([
      [query(), "page", ["A", "B"], query("09")],
      [query("09"), "page", [], bucket("08")],
      [bucket("08"), "page", ["C", "D", "E"], expect.objectContaining({ kind: "bucket", position: 3 })],
      [expect.objectContaining({ position: 3 }), "restart", [], bucket("08")],
      [bucket("08"), "page", ["D", "E", "F"], expect.objectContaining({ kind: "bucket", position: 3 })],
      [expect.objectContaining({ position: 3 }), "page", ["Z"], query("08")],
      [query("08"), "page", ["G", "H", "Y"], { kind: "verify", afterEmailId: null }],
    ]);
    for (const id of ["B", "D", "E", "F", "G", "H"]) expect(reads.filter((read) => read === id)).toEqual([id]);
    const [first] = posted(f);
    expect(first?.[1]).toEqual({
      accountId: "d333333",
      sort: [{ property: "receivedAt", isAscending: false }],
      position: 0,
      limit: 3,
      calculateTotal: true,
      collapseThreads: false,
    });
    expect(posted(f)[1]?.[1]).toMatchObject({ "#ids": { resultOf: "scan", name: "Email/query", path: "/ids" } });
    const bucketQuery = posted(f).find(([name, args]) => name === "Email/query" && args.position === 3);
    expect(bucketQuery?.[1].filter).toEqual({ after: at("08"), before: at("09") });
  });

  test("more than N messages in one second page through the bucket, then continue before it", async () => {
    const { f, page } = await setup(3);
    f.emails.push(mail("new", "30"), ...Array.from({ length: 7 }, (_, i) => mail(`same${i}`, "20")), mail("old", "10"));
    const { reads, trace } = await walk(page);
    expect(reads.sort()).toEqual(f.emails.map((email) => email.id).sort());
    expect(trace.map(({ step }) => step)).toEqual([
      query(),
      query("21"),
      bucket("20"),
      expect.objectContaining({ kind: "bucket", position: 3 }),
      expect.objectContaining({ kind: "bucket", position: 6 }),
      query("20"),
    ]);
  });

  test("fractional receivedAt belongs to its whole second at both bounds", async () => {
    const { f, page } = await setup(3);
    f.emails.push(mail("late", "20.999"), mail("early", "20.001"), mail("whole", "20"), mail("before", "19.5"), mail("next", "21"));
    const first = await page(query());
    // next, late, early: two seconds; second 20 is read again in full.
    expect(first).toMatchObject({ kind: "page", next: query("21") });
    expect(ids(first)).toEqual(["next"]);
    const second = await page(query("21"));
    expect(second).toMatchObject({ next: bucket("20") });
    const inBucket = await page(bucket("20"));
    expect(ids(inBucket)).toEqual(["late", "early", "whole"]);
    expect(inBucket).toMatchObject({ next: query("20") });
    expect(ids(await page(query("20")))).toEqual(["before"]);
  });

  test("a smaller server limit is not the end of the scan", async () => {
    const { f, page } = await setup(3);
    f.controls.emailQueryLimit = 1;
    f.emails.push(mail("a", "03"), mail("b", "02"), mail("c", "01"));
    const { reads, trace } = await walk(page);
    expect(reads.sort()).toEqual(["a", "b", "c"]);
    expect(trace[0]?.result.next).toEqual(bucket("03"));
  });

  test("an empty account completes at once", async () => {
    const { page } = await setup();
    expect(await page(query())).toEqual({
      kind: "page",
      objects: [],
      notFoundIds: [],
      next: { kind: "verify", afterEmailId: null },
      emailState: "emails-state",
    });
  });

  test("a non-final page whose IDs all vanish restarts the same step; a final one ends", async () => {
    const { f, page } = await setup(2);
    f.emails.push(mail("a", "03"), mail("b", "02"), mail("c", "01"));
    f.controls.afterEmailQuery = () => {
      f.emails.splice(0, 2);
      f.controls.afterEmailQuery = undefined;
    };
    expect(await page(query())).toEqual({ kind: "restart", next: query(), emailState: "emails-state" });
    f.controls.afterEmailQuery = () => f.emails.splice(0);
    expect(await page(query())).toEqual({
      kind: "page",
      objects: [],
      notFoundIds: ["c"],
      next: { kind: "verify", afterEmailId: null },
      emailState: "emails-state",
    });
  });

  test("a vanished ID advances the bucket position but never yields a bound", async () => {
    const { f, page } = await setup(2);
    f.emails.push(mail("a", "05"), mail("b", "05"), mail("c", "05"), mail("gone", "09"), mail("d", "04"));
    // In a query: the vanished newest ID gives no second, so the remaining page is one second only.
    f.controls.afterEmailQuery = () => {
      f.emails.splice(3, 1);
      f.controls.afterEmailQuery = undefined;
    };
    expect(await page(query())).toEqual({
      kind: "page",
      objects: [],
      notFoundIds: ["gone"],
      next: bucket("05"),
      emailState: "emails-state",
    });
    const first = await page(bucket("05"));
    if (first.kind !== "page" || first.next.kind !== "bucket") throw new Error("bucket page expected");
    f.controls.afterEmailQuery = () => f.emails.splice(2, 1);
    const second = await page(first.next);
    expect(second).toEqual({ kind: "page", objects: [], notFoundIds: ["c"], next: query("05"), emailState: "emails-state" });
  });

  test("a changed bucket queryState restarts at position zero without objects", async () => {
    const { f, page } = await setup(2);
    f.emails.push(mail("a", "05"), mail("b", "05"), mail("c", "05"));
    const first = await page(bucket("05"));
    if (first.kind !== "page" || first.next.kind !== "bucket") throw new Error("bucket page expected");
    f.emails.push(mail("d", "05"));
    expect(await page(first.next)).toEqual({ kind: "restart", next: bucket("05"), emailState: "emails-state" });
    // A different filter is a different query: its queryState is not compared.
    expect((await page(query())).kind).toBe("page");
  });

  test("halves an oversized page down to one and then fails visibly", async () => {
    const { f, page } = await setup(4);
    f.emails.push(...["a", "b", "c", "d"].map((id, i) => mail(id, `0${4 - i}`)));
    // Two of these exceed the 2 MiB budget together, one alone does not.
    for (const email of f.emails.slice(0, 2)) email.subject = "x".repeat(1_100_000);
    const result = await page(query());
    expect(ids(result)).toEqual([]);
    expect(result.kind === "page" && result.next).toEqual(bucket("04"));
    expect(
      posted(f)
        .filter(([name]) => name === "Email/query")
        .map(([, args]) => args.limit),
    ).toEqual([4, 2, 1]);
    const big = f.emails[0];
    if (!big) throw new Error("fixture email missing");
    big.subject = "x".repeat(JMAP_EMAIL_RESPONSE_BYTES);
    await expect(page(bucket("04"))).rejects.toMatchObject({ code: "JMAP_EMAIL_TOO_LARGE" });
  });

  test("maxCallsInRequest=1 reads query and envelopes in separate requests", async () => {
    const { f, page } = await setup(3, 1);
    f.emails.push(mail("a", "03"), mail("b", "02"));
    const result = await page(query());
    expect(result).toMatchObject({ kind: "page", next: { kind: "verify" } });
    expect(ids(result)).toEqual(["a", "b"]);
    expect(f.requests.filter((request) => request.calls).map((request) => request.calls?.map(([name]) => name))).toEqual([
      ["Email/query"],
      ["Email/get"],
    ]);
  });

  /** Numbers every Email/get answer, including oversized attempts, so a test can name the last one. */
  const countGets = (f: ReturnType<typeof createJmapFixture>) => {
    let gets = 0;
    f.controls.transform = ([name, args, id]: JmapInvocation): JmapInvocation =>
      name === "Email/get" ? [name, { ...args, state: `get-${++gets}` }, id] : [name, args, id];
  };
  for (const maxCalls of [16, 1])
    test(`emailState is the state of the step's last get (maxCallsInRequest=${maxCalls})`, async () => {
      const combined = maxCalls > 1;
      const { f, page } = await setup(2, maxCalls);
      countGets(f);
      expect((await page(query())).emailState, "empty final page").toBe("get-1");
      f.emails.push(mail("a", "05"), mail("b", "05"), mail("c", "05"));
      const first = await page(bucket("05"));
      expect(first, "page").toMatchObject({ kind: "page", emailState: "get-2" });
      if (first.kind !== "page" || first.next.kind !== "bucket") throw new Error("bucket page expected");
      f.emails.push(mail("d", "05"));
      const before = f.requests.length;
      // Combined, the restart reads the get of its own request; alone, an empty get before any other.
      expect(await page(first.next), "queryState restart").toEqual({ kind: "restart", next: bucket("05"), emailState: "get-3" });
      expect(
        f.requests.slice(before).map((request) => request.calls?.map(([name, args]) => [name, args.ids ?? null])),
        "queryState restart: requests",
      ).toEqual(
        combined
          ? [
              [
                ["Email/query", null],
                ["Email/get", null],
              ],
            ]
          : [[["Email/query", null]], [["Email/get", []]]],
      );
      f.emails.splice(0);
      f.emails.push(mail("x", "03"), mail("y", "02"), mail("z", "01"));
      f.controls.afterEmailQuery = () => {
        f.emails.splice(0, 2);
        f.controls.afterEmailQuery = undefined;
      };
      expect(await page(query()), "vanished restart").toEqual({ kind: "restart", next: query(), emailState: "get-4" });
    });
  for (const maxCalls of [16, 1])
    test(`after halving, emailState is the state of the get that counted (maxCallsInRequest=${maxCalls})`, async () => {
      const { f, page } = await setup(4, maxCalls);
      f.emails.push(...["a", "b", "c", "d"].map((id, i) => mail(id, `0${4 - i}`)));
      for (const email of f.emails.slice(0, 2)) email.subject = "x".repeat(1_100_000);
      countGets(f);
      // Combined: gets of 4 and 2 objects are too large, the third counts. Alone: [a-d] and [a, b]
      // are too large, then one object per get: a, b, c, d.
      expect((await page(query())).emailState).toBe(maxCalls > 1 ? "get-3" : "get-6");
    });

  const invalid: Array<[string, (args: Record<string, unknown>) => Record<string, unknown>]> = [
    ["wrong account", (args) => ({ ...args, accountId: "other" })],
    ["wrong position", (args) => ({ ...args, position: 1 })],
    ["duplicate ids", (args) => ({ ...args, ids: ["a", "a"], total: 3 })],
    ["more ids than requested", (args) => ({ ...args, ids: ["a", "b", "c", "d"], total: 4 })],
    ["more ids than the reported server limit", (args) => ({ ...args, limit: 1 })],
    ["missing total", ({ total: _total, ...args }) => args],
    ["impossible total", (args) => ({ ...args, total: 1 })],
    ["empty non-final page", (args) => ({ ...args, ids: [], total: 3 })],
  ];
  for (const [label, change] of invalid)
    test(`rejects an Email/query response with ${label}`, async () => {
      const { f, page } = await setup(3, 1);
      f.emails.push(mail("a", "03"), mail("b", "02"), mail("c", "01"), mail("d", "00"));
      patch(f, "Email/query", change);
      await expect(page(query())).rejects.toMatchObject({ code: "JMAP_INVALID_RESPONSE" });
    });

  test("rejects objects outside the range, in the wrong order, or not covering the query", async () => {
    const { f, page } = await setup(3);
    f.emails.push(mail("a", "03"), mail("b", "02"));
    patch(f, "Email/query", (args) => ({ ...args, ids: ["b", "a"] }));
    await expect(page(query())).rejects.toMatchObject({ code: "JMAP_INVALID_RESPONSE" });
    patch(f, "Email/get", (args) => ({ ...args, notFound: ["a"] }));
    await expect(page(query())).rejects.toMatchObject({ code: "JMAP_INVALID_RESPONSE" });
    f.controls.transform = undefined;
    await expect(page(query("03"))).resolves.toMatchObject({ kind: "page" });
    patch(f, "Email/query", (args) => ({ ...args, ids: ["a"], total: 1 }));
    await expect(page(query("03"))).rejects.toMatchObject({ code: "JMAP_INVALID_RESPONSE" });
    await expect(page(bucket("04"))).rejects.toMatchObject({ code: "JMAP_INVALID_RESPONSE" });
  });

  for (const methodType of ["unsupportedSort", "unsupportedFilter", "forbidden"])
    test(`surfaces ${methodType} from the query, not from the dependent get`, async () => {
      const { f, page } = await setup();
      f.methodErrors.set("Email/query", methodType);
      await expect(page(query())).rejects.toMatchObject({ code: "JMAP_METHOD", methodType });
    });

  test("the fixture rejects unsupported sorts and filters itself", async () => {
    const { f, session } = await setup();
    const call = async (args: Record<string, unknown>) =>
      requireJmapMethodResult(
        await callJmap(
          {
            session,
            authorization: "Basic fictional-unused",
            signal: new AbortController().signal,
            using: [JMAP_CORE, JMAP_MAIL],
            methodCalls: [["Email/query", { accountId: "d333333", ...args }, "q"]],
          },
          f.dependencies,
        ),
        "q",
        "Email/query",
      );
    await expect(call({ sort: [{ property: "size" }] })).rejects.toMatchObject({ methodType: "unsupportedSort" });
    await expect(call({ filter: { inMailbox: "a" } })).rejects.toMatchObject({ methodType: "unsupportedFilter" });
  });

  test("rejects a verify step or an invalid step before any request", async () => {
    const { f, page } = await setup();
    const verify: JmapScanStep = { kind: "verify", afterEmailId: null };
    // @ts-expect-error verify is not a page step.
    await expect(page(verify)).rejects.toBeInstanceOf(RangeError);
    await expect(page({ kind: "query", before: "2026-11-19T10:00:00.5Z" })).rejects.toBeInstanceOf(RangeError);
    expect(posted(f)).toEqual([]);
  });
});

describe("jmapScanStepSchema", () => {
  test("accepts the three step kinds", () => {
    for (const step of [
      query(),
      query("05"),
      bucket("05"),
      bucket("05", 3, "q1"),
      { kind: "bucket", second: at("05"), position: Number.MAX_SAFE_INTEGER, queryState: "q" },
      { kind: "verify", afterEmailId: null },
      { kind: "verify", afterEmailId: "e1" },
    ])
      expect(jmapScanStepSchema.safeParse(step).success).toBe(true);
  });
  for (const [label, step] of [
    ["fractional before", { kind: "query", before: "2026-11-19T10:00:05.5Z" }],
    ["offset before", { kind: "query", before: "2026-11-19T10:00:05+01:00" }],
    ["impossible date", { kind: "query", before: "2026-02-30T10:00:05Z" }],
    ["missing before", { kind: "query" }],
    ["fractional bucket", { kind: "bucket", second: "2026-11-19T10:00:05.000Z", position: 0, queryState: null }],
    ["position without queryState", { kind: "bucket", second: at("05"), position: 1, queryState: null }],
    ["negative position", { kind: "bucket", second: at("05"), position: -1, queryState: "q" }],
    ["unsafe position", { kind: "bucket", second: at("05"), position: Number.MAX_SAFE_INTEGER + 1, queryState: "q" }],
    ["oversized queryState", { kind: "bucket", second: at("05"), position: 1, queryState: "q".repeat(1_025) }],
    ["invalid verify id", { kind: "verify", afterEmailId: "bad/id" }],
    ["unknown kind", { kind: "catchup" }],
    ["tail", { kind: "tail" }],
    ["extra field", { kind: "query", before: null, restarts: 0 }],
    ["extra bucket field", { kind: "bucket", second: at("05"), position: 0, queryState: null, limit: 3 }],
  ] as const)
    test(`rejects ${label}`, () => expect(jmapScanStepSchema.safeParse(step).success).toBe(false));
});

describe("readJmapEmailExistence", () => {
  test("splits found and missing IDs with one bounded ID-only get", async () => {
    const { f, exists } = await setup(500);
    f.emails.push(mail("a", "01"), mail("b", "02"));
    expect(await exists(["gone", "b", "a"])).toEqual({ foundIds: ["b", "a"], notFoundIds: ["gone"] });
    expect(posted(f)).toEqual([["Email/get", { accountId: "d333333", ids: ["gone", "b", "a"], properties: ["id"] }, "existence"]]);
    expect(await exists([])).toEqual({ foundIds: [], notFoundIds: [] });
    expect(posted(f)).toHaveLength(1);
  });

  test("rejects input above min(500, maxObjectsInGet) as a programming error", async () => {
    const small = await setup(3);
    expect(jmapEmailExistenceLimit(small.session)).toBe(3);
    await expect(small.exists(["a", "b", "c", "d"])).rejects.toBeInstanceOf(RangeError);
    const large = await setup(1_000);
    expect(jmapEmailExistenceLimit(large.session)).toBe(500);
    await expect(large.exists(Array.from({ length: 501 }, (_, i) => `e${i}`))).rejects.toBeInstanceOf(RangeError);
    expect(posted(small.f)).toEqual([]);
    expect(posted(large.f)).toEqual([]);
    await expect(small.exists(["a", "a"])).rejects.toMatchObject({ code: "JMAP_INVALID_ID" });
  });

  for (const [label, change] of [
    ["an extra id", (args: Record<string, unknown>) => ({ ...args, notFound: ["a", "extra"] })],
    ["a missing id", (args: Record<string, unknown>) => ({ ...args, notFound: [] })],
    ["an id in both lists", (args: Record<string, unknown>) => ({ ...args, list: [{ id: "a" }], notFound: ["a"] })],
  ] as const)
    test(`rejects a response with ${label}`, async () => {
      const { f, exists } = await setup();
      patch(f, "Email/get", change);
      await expect(exists(["a"])).rejects.toMatchObject({ code: "JMAP_INVALID_RESPONSE" });
    });
});

describe("readJmapAccountStart", () => {
  test("reads start states from empty gets and a folder snapshot with the same state", async () => {
    const { f, start } = await setup(2);
    const result = await start();
    expect(result).toMatchObject({ kind: "ready", emailState: "emails-state", mailboxState: "mailboxes-state" });
    expect(result.kind === "ready" && result.folders.map((folder) => [folder.mailboxId, folder.path])).toEqual([
      ["a", "Inbox"],
      ["b", "Projects"],
      ["c", "Projects/Example"],
    ]);
    const calls = posted(f).map(([name, args]) => [name, args.ids ?? null]);
    expect(calls).toEqual([
      ["Email/get", []],
      ["Mailbox/get", []],
      ["Mailbox/query", null],
      ["Mailbox/query", null],
      ["Mailbox/get", ["a", "b"]],
      ["Mailbox/get", ["c"]],
      ["Mailbox/get", []],
    ]);
  });

  test("an account without mailboxes or mail is ready", async () => {
    const { f, start } = await setup();
    f.mailboxes.splice(0);
    expect(await start()).toEqual({ kind: "ready", emailState: "emails-state", mailboxState: "mailboxes-state", folders: [] });
  });

  test("reports changed when the mailbox state moves between gets", async () => {
    for (const moveAt of [1, 2, 3]) {
      const { f, start } = await setup(2);
      let gets = 0;
      f.controls.transform = ([name, args, id]) => {
        if (name === "Mailbox/get" && ++gets > moveAt) return [name, { ...args, state: "moved" }, id];
        return [name, args, id];
      };
      expect(await start()).toEqual({ kind: "changed" });
    }
  });

  test("reports changed when a mailbox is destroyed between the query and its get", async () => {
    const { f, start } = await setup();
    f.controls.transform = ([name, args, id]) => {
      const list = Array.isArray(args.list) ? args.list : [];
      if (name !== "Mailbox/get" || list.length === 0) return [name, args, id];
      return [name, { ...args, state: "moved", list: list.slice(1), notFound: ["a"] }, id];
    };
    expect(await start()).toEqual({ kind: "changed" });
  });

  test("reports changed when the folder queryState moves between pages", async () => {
    const { f, start } = await setup(2);
    let pages = 0;
    patch(f, "Mailbox/query", (args) => ({ ...args, queryState: ++pages > 1 ? "moved" : args.queryState }));
    expect(await start()).toEqual({ kind: "changed" });
    expect(posted(f).filter(([name, args]) => name === "Mailbox/get" && Array.isArray(args.ids) && args.ids.length)).toEqual([]);
  });

  test("keeps the discovery bounds and invalid folder data", async () => {
    const { f, start } = await setup();
    let pages = 0;
    patch(f, "Mailbox/query", (args) => ({ ...args, total: 1_000_000, position: pages, ids: [`f${pages++}`] }));
    await expect(start()).rejects.toMatchObject({ code: "JMAP_DISCOVERY_LIMIT" });
    expect(pages).toBe(JMAP_DISCOVERY_PAGES);
    const cycle = await setup();
    const parent = cycle.f.mailboxes[1];
    if (!parent) throw new Error("fixture mailbox missing");
    parent.parentId = "c";
    await expect(cycle.start()).rejects.toMatchObject({ code: "JMAP_FOLDER_TREE" });
    const extra = await setup();
    extra.f.mailboxes.push(fixtureMailbox("bad/id", "Bad"));
    await expect(extra.start()).rejects.toMatchObject({ code: "JMAP_INVALID_RESPONSE" });
  });

  test("rejects a non-empty start get", async () => {
    const { f, start } = await setup();
    patch(f, "Email/get", (args) => ({ ...args, notFound: ["x"] }));
    await expect(start()).rejects.toMatchObject({ code: "JMAP_INVALID_RESPONSE" });
  });
});
