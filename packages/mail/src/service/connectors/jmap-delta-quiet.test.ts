import { afterEach, expect, test } from "bun:test";
import { fetchJmapSession, JMAP_CORE, type JmapInvocation } from "./jmap-client";
import { readJmapAccountQuiet } from "./jmap-delta";
import { createJmapFixture } from "./jmap-fixture";

const fixtures: ReturnType<typeof createJmapFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});
async function setup(maxCalls = 16) {
  const f = createJmapFixture();
  fixtures.push(f);
  f.session.capabilities[JMAP_CORE].maxCallsInRequest = maxCalls;
  const signal = new AbortController().signal;
  const authorization = "Basic fictional-unused";
  const session = await fetchJmapSession({ origin: f.origin, authorization, signal }, f.dependencies);
  const probe = (states = { mailboxState: "Mailbox:0", emailState: "Email:0" }) =>
    readJmapAccountQuiet(session, authorization, "d333333", states, signal, f.dependencies);
  /** The method calls of each API request, in order. */
  const calls = () =>
    f.requests.flatMap((request) => (request.calls ? [request.calls.map(([name, args]) => [name, args.maxChanges])] : []));
  return { f, probe, calls };
}
/** Replaces one method's response arguments. */
const rewrite =
  (method: string, change: (args: Record<string, unknown>) => Record<string, unknown>) =>
  ([name, args, id]: JmapInvocation): JmapInvocation =>
    name === method ? [name, change(args), id] : [name, args, id];

test("quiet: both states unchanged, one request with two changes calls of one change each and no get", async () => {
  const { probe, calls } = await setup();
  expect(await probe()).toEqual({ quiet: true });
  expect(calls()).toEqual([
    [
      ["Mailbox/changes", 1],
      ["Email/changes", 1],
    ],
  ]);
});

test("a moved mailbox state is not quiet, whatever the Email state does", async () => {
  const { f, probe } = await setup();
  f.journal.Mailbox.push({ id: "a", kind: "updated" });
  f.methodErrors.set("Email/changes", "invalidArguments");
  expect(await probe()).toEqual({ quiet: false });
});

test("a moved Email state is not quiet", async () => {
  const { f, probe } = await setup();
  f.journal.Email.push({ id: "new", kind: "created" });
  expect(await probe()).toEqual({ quiet: false });
});

test("a state that moved without IDs, or IDs without a moved state, is not quiet", async () => {
  const moved = await setup();
  moved.f.controls.transform = rewrite("Email/changes", (args) => ({ ...args, newState: "Email:9" }));
  expect(await moved.probe()).toEqual({ quiet: false });
  const reported = await setup();
  reported.f.controls.transform = rewrite("Mailbox/changes", (args) => ({ ...args, updated: ["a"] }));
  expect(await reported.probe()).toEqual({ quiet: false });
});

test("a rejected state names its axis", async () => {
  const mailbox = await setup();
  mailbox.f.methodErrors.set("Mailbox/changes", "invalidArguments");
  expect(await mailbox.probe()).toEqual({ rejected: "mailbox", cause: "state_rejected" });
  const email = await setup();
  email.f.methodErrors.set("Email/changes", "cannotCalculateChanges");
  expect(await email.probe()).toEqual({ rejected: "email", cause: "cannot_calculate" });
});

test("maxCallsInRequest = 1: two requests when the mailboxes are quiet, one when they moved", async () => {
  const quiet = await setup(1);
  expect(await quiet.probe()).toEqual({ quiet: true });
  expect(quiet.calls()).toEqual([[["Mailbox/changes", 1]], [["Email/changes", 1]]]);
  const moved = await setup(1);
  moved.f.journal.Mailbox.push({ id: "a", kind: "updated" });
  expect(await moved.probe()).toEqual({ quiet: false });
  expect(moved.calls()).toEqual([[["Mailbox/changes", 1]]]);
});

test("an answer for another state than the one asked is invalid", async () => {
  const { f, probe } = await setup();
  f.controls.transform = rewrite("Email/changes", (args) => ({ ...args, oldState: "Email:7" }));
  await expect(probe()).rejects.toMatchObject({ code: "JMAP_INVALID_RESPONSE" });
});
