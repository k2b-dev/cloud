import { afterEach, expect, spyOn, test } from "bun:test";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { AssistantLiveProvider, createAssistantLiveHub } from "./assistant-live";
import { type CodeVersionPreview, type CodeVersionReview, codeVersionOwnPageHref, codeVersionPageHref } from "./code-activation";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const codeId = "c_info01";
const versionId = "66666666-6666-4666-8666-666666666666";
const WORDS = "/api/capabilities/v1/queries/core/code.version.words";
const AUTOMATIONS = "/api/capabilities/v1/queries/core/code.automation.list";

const preview = (patch: Partial<CodeVersionPreview> = {}): CodeVersionPreview => ({
  codeId,
  title: "Code of info@",
  ownerKind: "resource",
  versionId,
  number: 5,
  running: 4,
  latest: 5,
  activated: null,
  allowed: { allowed: true },
  readiness: { state: "ready" },
  tests: { state: "passed", passed: 3, total: 3 },
  place: { title: "info@example.test", typeTitle: "mailbox", href: "/app/mail/m_info" },
  page: "/app/mail/m_info/code",
  ...patch,
});
const review = (patch: Partial<CodeVersionReview> = {}): CodeVersionReview => ({
  status: "not_required",
  origin: { kind: "ai_chat", conversationId: "chat-1", automaticAfterReview: false },
  decidedBy: null,
  decidedAt: null,
  message: null,
  comments: [],
  commentCount: 0,
  activeVersion: { id: "v4", number: 4 },
  ...patch,
});
const words = (patch: Record<string, unknown> = {}) => ({
  versionId,
  number: 5,
  submittedAt: "2026-11-12T08:00:00.000Z",
  locale: "en",
  description: { state: "visible", text: "Files delivery notes.", modelLabel: "✦" },
  assurance: "Cloud limits access to the apps and targets of this version.",
  mayDo: { items: [], more: 0, moreText: null },
  timing: { items: [], more: 0, moreText: null },
  changes: {
    state: "changed",
    text: "Access or triggers changed",
    rows: {
      items: [
        { kind: "add", text: "Runs additionally Mon–Fri at 08:00" },
        { kind: "add", text: "May newly store files in folder Delivery notes 2026" },
        { kind: "remove", text: "May no longer mark conversations in mailbox info@example.test" },
        { kind: "same", text: "5 more stay the same" },
      ],
      more: 0,
      moreText: null,
    },
    assurance: "Cloud checks access and triggers, not behavior.",
  },
  examples: { state: "passed", passed: 3, total: 3, summary: "3 of 3 examples successful", explanation: "", items: [] },
  notices: { items: [], more: 0, moreText: null },
  ...patch,
});
const JANA = { id: "u-jana", name: "Jana Probe", avatarHash: null };

const restore: Array<() => void> = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

/** Mounts the card with Core's routes answered by `routes`; a missing route is an outage. */
type Answer = { status?: number; json?: unknown };
type Routes = Record<string, (body: unknown) => Answer | Promise<Answer>>;
const mount = async (given: Routes, options: { onAsk?: (text: string) => void } = {}) => {
  // The review and the words answer like Core does for an ordinary ready version, unless a test says otherwise.
  const routes: Routes = { review: () => ({ json: { data: review() } }), [WORDS]: () => ({ json: { data: words() } }), ...given };
  const dom = createDomTestHarness();
  const calls: Array<{ route: string; body: unknown }> = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    const route = String(url).replace("/api/code/", "");
    const body = JSON.parse(String(init?.body ?? "null"));
    calls.push({ route, body });
    const answer = await routes[route]?.(body);
    if (!answer) return new Response("{}", { status: 503 });
    return new Response(JSON.stringify(answer.json ?? {}), { status: answer.status ?? 200 });
  }) as unknown as typeof fetch);
  const { default: Card } = await import("./AssistantCodeVersionCard");
  const activated: number[] = [];
  const live = createAssistantLiveHub();
  const dispose = render(
    () => (
      <AssistantLiveProvider value={live}>
        <Card codeId={codeId} versionId={versionId} number={5} timeZone="UTC" onActivated={() => activated.push(1)} onAsk={options.onAsk} />
      </AssistantLiveProvider>
    ),
    dom.root,
  );
  restore.push(() => {
    dispose();
    fetchSpy.mockRestore();
    dom.cleanup();
  });
  await tick();
  return { dom, calls, activated, live, previews: () => calls.filter((call) => call.route === "activation/preview").length };
};
/** One update on the person's AI live channel, as Core's decision trigger writes it. */
const decided = (domains: Array<"code-versions" | "conversation-detail"> = ["code-versions"]) => ({
  type: "ai.invalidated" as const,
  changeId: "77777777-7777-4777-8777-777777777777",
  conversationId: null,
  projectId: null,
  domains,
  at: "2026-11-12T08:00:00.000Z",
});
const button = (root: Element, name: string) =>
  [...root.querySelectorAll("button, a")].find((element) => element.textContent?.trim().includes(name)) as HTMLElement | undefined;
const status = (root: Element) => root.querySelector(".k2b-chat-decision__status")?.textContent?.trim() ?? null;
const text = (root: Element) => (root.textContent ?? "").replace(/\s+/g, " ");
/** The patterns the code-no-source rule forbids in what a person reads. */
const expectNoCode = (root: Element) => {
  const shown = text(root);
  for (const pattern of [/\bcode\.tsx?\b/i, /\.[a-z]{1,8}:\d+/i, /\bcode_[a-z_]+\b/, /\b[0-9a-f]{8,}\b/i]) expect(shown).not.toMatch(pattern);
};

test("ready: one approval form with the question, what changes against the running version, the examples and the switch", async () => {
  const { dom, calls } = await mount({ "activation/preview": () => ({ json: { data: preview() } }) });
  const card = dom.root.querySelector(".k2b-chat-decision")!;
  expect(card.getAttribute("data-k2b-primary")).toBe("ai");
  expect(card.getAttribute("data-chat-anchor")).toBe(`code-version-${versionId}`);
  expect(text(card)).toContain("Approval·Code");
  expect(card.querySelector(".k2b-chat-decision__sentence")?.textContent).toBe("Version 5 of Code of info@ switch on?");
  expect(text(card)).toContain("It may do more than version 4 afterwards.");
  expect(text(card)).toContain("Details from Code · compared with version 4");
  const rows = [...card.querySelectorAll(".k2b-change-list__item")].map((row) => row.getAttribute("data-tone"));
  expect(rows).toEqual(["add", "add", "remove", "neutral"]);
  expect(text(card)).toContain("Cloud checks access and triggers, not behavior.");
  expect(text(card)).toContain("3 of 3 examples successful");
  expect(text(card)).toContain("Until then version 4 stays switched on");
  // An open question has no state word; the difference button is gone, the version opens on the Code page.
  expect(status(dom.root)).toBeNull();
  expect(button(dom.root, "Difference")).toBeUndefined();
  expect(button(dom.root, "See everything")?.getAttribute("href")).toBe(`/app/mail/m_info/code?tab=versions&version=${versionId}`);
  expect(button(dom.root, "Switch on version 5")?.getAttribute("data-variant")).toBe("ai");
  expect(calls.some((call) => call.route === "activate")).toBe(false);
  expectNoCode(dom.root);
});

test("without examples the card warns, offers to try examples first and to switch on anyway", async () => {
  const asked: string[] = [];
  const { dom } = await mount(
    {
      "activation/preview": () => ({ json: { data: preview({ tests: { state: "none", passed: 0, total: 0 } }) } }),
      [WORDS]: () => ({ json: { data: words({ examples: { state: "none", passed: 0, total: 0, summary: "", explanation: "", items: [] } }) } }),
    },
    { onAsk: (value) => asked.push(value) },
  );
  expect(text(dom.root)).toContain("No examples: nobody has tried what it does");
  expect(button(dom.root, "Switch on anyway")).toBeDefined();
  button(dom.root, "Try examples first")!.click();
  expect(asked).toEqual(["Try out examples for version 5 first."]);
});

test("switching on runs Core's activation; with nothing below the card shrinks to one line, the same after a reload", async () => {
  let on = false;
  const { dom, calls, activated } = await mount({
    "activation/preview": () => ({
      json: {
        data: on ? preview({ running: 5, activated: { at: "2026-10-31T14:20:00.000Z", byYou: true, byName: null } }) : preview(),
      },
    }),
    activate: () => {
      on = true;
      return { json: { data: { state: "active", failure: null } } };
    },
    [AUTOMATIONS]: () => ({ json: { data: { items: [], removedTargets: [] } } }),
  });
  button(dom.root, "Switch on version 5")!.click();
  await tick();
  await tick();
  expect(calls.find((call) => call.route === "activate")!.body).toMatchObject({ codeId, versionId });
  expect(activated).toEqual([1]);
  expect(status(dom.root)).toBe("Switched on");
  expect(text(dom.root)).toMatch(/Version 5 has been switched on since .*\./);
  expect(button(dom.root, "Switch on version 5")).toBeUndefined();
  expect(button(dom.root, "See runs")).toBeDefined();
});

test("while Cloud switches on, the card says so in place, and a lost answer reads Core's status once", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { dom, calls } = await mount({
    "activation/preview": () => ({ json: { data: preview() } }),
    activate: async () => {
      await held;
      return { status: 503 };
    },
    "activation/read": () => ({ json: { data: { state: "failed", failure: null } } }),
  });
  button(dom.root, "Switch on version 5")!.click();
  await tick();
  expect(status(dom.root)).toBe("Switching on");
  expect(text(dom.root)).toContain("Version 5 is being switched on …");
  release();
  await tick();
  await tick();
  expect(calls.filter((call) => call.route === "activate")).toHaveLength(1);
  expect(calls.filter((call) => call.route === "activation/read")).toHaveLength(1);
});

test("a refusal says Cloud refused and what stays on, and trying again uses a new identity", async () => {
  const { dom, calls } = await mount({
    "activation/preview": () => ({ json: { data: preview() } }),
    activate: () => ({ json: { data: { state: "failed", failure: { reason: "Owner authority changed." } } } }),
  });
  button(dom.root, "Switch on version 5")!.click();
  await tick();
  expect(status(dom.root)).toBe("Failed");
  expect(text(dom.root)).toContain("Cloud refused to switch it on. Version 4 stays switched on.");
  button(dom.root, "Try again")!.click();
  await tick();
  const ids = calls.filter((call) => call.route === "activate").map((call) => (call.body as { activationId: string }).activationId);
  expect(ids).toHaveLength(2);
  expect(ids[0]).not.toBe(ids[1]);
});

test("an unclear outcome offers only to check the status, never to try again; a failed check says Cloud tries again", async () => {
  const { dom } = await mount({
    "activation/preview": () => ({ json: { data: preview() } }),
    activate: () => ({ status: 503 }),
    "activation/read": () => ({ status: 503 }),
  });
  button(dom.root, "Switch on version 5")!.click();
  await tick();
  await tick();
  expect(status(dom.root)).toBe("Outcome unclear");
  expect(text(dom.root)).toContain("The status could not be checked. Cloud tries again in 30 seconds.");
  expect(button(dom.root, "Check now")).toBeDefined();
  expect(button(dom.root, "Try again")).toBeUndefined();
});

test("waiting for admin explains who approves, what happens now and what holds until then, without names", async () => {
  const asked: string[] = [];
  const { dom } = await mount(
    {
      "activation/preview": () => ({ json: { data: preview({ readiness: { state: "approval_pending" } }) } }),
      review: () => ({ json: { data: review({ status: "pending" }) } }),
    },
    { onAsk: (value) => asked.push(value) },
  );
  expect(status(dom.root)).toBe("Waiting for admin");
  expect(dom.root.querySelector(".k2b-chat-decision__sentence")?.textContent).toBe("Version 5 of Code of info@ waits for an admin’s approval.");
  expect(text(dom.root)).toContain("In your Cloud an admin approves every automation that does something others see.");
  expect(text(dom.root)).toContain("The admins know. You get a notification as soon as one of them has decided.");
  expect(text(dom.root)).toContain("Until then version 4 stays switched on. You do not need to do anything.");
  expect(text(dom.root)).not.toContain("Jana");
  expect(button(dom.root, "Switch on")).toBeUndefined();
  button(dom.root, "Build without approval")!.click();
  expect(asked).toEqual(["Build version 5 so that it needs no admin approval."]);
});

test("withdrawing a waiting version asks Core and shows the withdrawn state", async () => {
  let withdrawn = false;
  const { dom, calls } = await mount({
    "activation/preview": () => ({ json: { data: preview({ readiness: { state: "approval_pending" } }) } }),
    review: () => ({ json: { data: review({ status: withdrawn ? "withdrawn" : "pending" }) } }),
    withdraw: () => {
      withdrawn = true;
      return { json: { data: {} } };
    },
  });
  button(dom.root, "Withdraw")!.click();
  await tick();
  await tick();
  expect(calls.find((call) => call.route === "withdraw")!.body).toEqual({ codeId, versionId });
  expect(status(dom.root)).toBe("Withdrawn");
  expect(text(dom.root)).toContain("Version 5 was withdrawn. Version 4 stays switched on.");
});

test("a first version says the automation stays off until then", async () => {
  const { dom } = await mount({
    "activation/preview": () => ({ json: { data: preview({ running: null, readiness: { state: "approval_pending" } }) } }),
    review: () => ({ json: { data: review({ status: "pending", activeVersion: null }) } }),
    [WORDS]: () => ({ json: { data: words({ changes: { ...words().changes, state: "first" } }) } }),
  });
  expect(text(dom.root)).toContain("Until then the automation does not run. You do not need to do anything.");
  expect(text(dom.root)).toContain("Details from Code · first version");
});

test("changes requested: the admin's message and comments as text, never a file or line, and Gustav revises on request", async () => {
  const asked: string[] = [];
  const { dom } = await mount(
    {
      "activation/preview": () => ({ json: { data: preview({ readiness: { state: "refused", code: "code_approval_revoked", message: "x" } }) } }),
      review: () => ({
        json: {
          data: review({
            status: "changes_requested",
            decidedBy: JANA,
            decidedAt: "2026-11-12T14:01:00.000Z",
            message: "Please store only PDF attachments.",
            comments: [{ id: "c1", author: JANA, createdAt: "2026-11-12T14:01:00.000Z", body: "Check the file type here.", parentId: null }],
            commentCount: 1,
          }),
        },
      }),
    },
    { onAsk: (value) => asked.push(value) },
  );
  expect(status(dom.root)).toBe("Changes requested");
  expect(text(dom.root)).toContain("Jana Probe reviewed it and has not approved it yet. Version 4 stays switched on.");
  expect(text(dom.root)).toContain("Message from Jana Probe");
  expect(text(dom.root)).toContain("Please store only PDF attachments.");
  expect(text(dom.root)).toContain("1 comment on a place in the code · Gustav knows the places");
  expect(text(dom.root)).toContain("Check the file type here.");
  expectNoCode(dom.root);
  button(dom.root, "Let Gustav revise")!.click();
  expect(asked).toEqual(["Revise version 5 the way Jana Probe wants it."]);
});

test("changes requested a second time: Gustav already revised once by himself, now the person decides", async () => {
  const { dom } = await mount({
    "activation/preview": () => ({ json: { data: preview({ readiness: { state: "refused", code: "code_approval_revoked", message: "x" } }) } }),
    review: () => ({
      json: {
        data: review({
          status: "changes_requested",
          origin: { kind: "ai_chat", conversationId: "chat-1", automaticAfterReview: true },
          decidedBy: JANA,
          decidedAt: "2026-11-12T14:19:00.000Z",
          message: "Almost. Please also limit the file size.",
        }),
      },
    }),
  });
  expect(text(dom.root)).toContain("Gustav has already revised it once by himself. Now you decide.");
});

test("rejected: the reason from the admin, and building it differently with Gustav", async () => {
  const { dom } = await mount({
    "activation/preview": () => ({ json: { data: preview({ readiness: { state: "refused", code: "code_approval_revoked", message: "rejected or revoked" } }) } }),
    review: () => ({ json: { data: review({ status: "rejected", decidedBy: JANA, decidedAt: "2026-11-12T14:01:00.000Z", message: "No shared folders." }) } }),
  });
  expect(status(dom.root)).toBe("Rejected");
  expect(text(dom.root)).toContain("Reason from Jana Probe");
  expect(text(dom.root)).toContain("No shared folders.");
  expect(text(dom.root)).not.toContain("rejected or revoked");
  expect(button(dom.root, "Switch on")).toBeUndefined();
});

test("approved: who approved it and what holds until the person switches it on", async () => {
  const { dom } = await mount({
    "activation/preview": () => ({ json: { data: preview() } }),
    review: () => ({ json: { data: review({ status: "approved", decidedBy: JANA, decidedAt: "2026-10-01T14:01:00.000Z" }) } }),
  });
  expect(text(dom.root)).toMatch(/Jana Probe approved it on .*\./);
  expect(text(dom.root)).toContain("Until you switch it on, version 4 stays switched on.");
  expect(button(dom.root, "Switch on version 5")).toBeDefined();
});

test("expired, superseded, no access and a failed load each have their one line and at most one answer", async () => {
  const asked: string[] = [];
  const expired = await mount(
    { "activation/preview": () => ({ json: { data: preview({ readiness: { state: "approval_pending" } }) } }), review: () => ({ json: { data: review({ status: "expired" }) } }) },
    { onAsk: (value) => asked.push(value) },
  );
  expect(status(expired.dom.root)).toBe("Expired");
  expect(text(expired.dom.root)).toContain("The request to the admins has expired. Version 4 stays switched on.");
  button(expired.dom.root, "Ask again")!.click();
  expect(asked).toEqual(["Submit version 5 again for approval."]);
  for (const undo of restore.splice(0)) undo();

  const older = await mount({ "activation/preview": () => ({ json: { data: preview({ latest: 6 }) } }) });
  expect(status(older.dom.root)).toBe("Superseded");
  expect(text(older.dom.root)).toContain("Version 5 was replaced by version 6. Its approval is further down.");
  for (const undo of restore.splice(0)) undo();

  const denied = await mount({ "activation/preview": () => ({ status: 403, json: {} }) });
  expect(status(denied.dom.root)).toBe("No access");
  expect(text(denied.dom.root)).toContain("You no longer manage this Code. Whoever manages it can switch it on.");
  for (const undo of restore.splice(0)) undo();

  let answers = 0;
  const down = await mount({ "activation/preview": () => (answers++ === 0 ? { status: 503 } : { json: { data: preview() } }) });
  expect(status(down.dom.root)).toBe("Not loaded");
  expect(text(down.dom.root)).toContain("This version could not be loaded. Cloud changed nothing.");
  button(down.dom.root, "Try again")!.click();
  await tick();
  expect(button(down.dom.root, "Switch on version 5")).toBeDefined();
});

test("a phone sees why it cannot switch on, in place of the reason", async () => {
  const { dom } = await mount({ "activation/preview": () => ({ json: { data: preview({ allowed: { allowed: false, reason: "phone" } }) } }) });
  expect(text(dom.root)).toContain("Switching on is not possible on a phone. It works on a computer.");
  expect(button(dom.root, "Switch on version 5")?.hasAttribute("disabled")).toBe(true);
});

test("the card loads with a placeholder and the word Loading", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { dom } = await mount({
    "activation/preview": async () => {
      await held;
      return { json: { data: preview() } };
    },
  });
  expect(status(dom.root)).toBe("Loading");
  expect(dom.root.querySelector('[aria-busy="true"]')).not.toBeNull();
  release();
  await tick();
  expect(status(dom.root)).toBeNull();
});

test("the card follows decisions and switch-ons from elsewhere on the live channel, without polling", async () => {
  let pending = true;
  const card = await mount({
    "activation/preview": () => ({ json: { data: preview({ readiness: { state: pending ? "approval_pending" : "ready" } }) } }),
    review: () => ({ json: { data: review({ status: pending ? "pending" : "approved", decidedBy: JANA, decidedAt: "2026-11-12T14:01:00.000Z" }) } }),
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(card.previews()).toBe(1);
  await card.live.apply([decided(["conversation-detail"])]);
  expect(card.previews()).toBe(1);
  pending = false;
  await card.live.apply([decided()]);
  await tick();
  expect(card.previews()).toBe(2);
  expect(button(card.dom.root, "Switch on version 5")?.hasAttribute("disabled")).toBe(false);
  // A ready card still follows: a switch-on in another tab reaches it too.
  await card.live.apply([decided()]);
  await tick();
  expect(card.previews()).toBe(3);
});

test("a decision whose read fails keeps the waiting card and is tried again by the live channel", async () => {
  let down = false;
  let pending = true;
  const card = await mount({
    "activation/preview": () => (down ? { status: 503 } : { json: { data: preview({ readiness: { state: pending ? "approval_pending" : "ready" } }) } }),
  });
  pending = false;
  down = true;
  await expect(card.live.apply([decided()])).rejects.toThrow();
  expect(status(card.dom.root)).toBe("Waiting for admin");
  down = false;
  await card.live.apply([decided()]);
  await tick();
  expect(button(card.dom.root, "Switch on version 5")?.hasAttribute("disabled")).toBe(false);
});

test("the Code page is the one the owner's app declares, or a personal Code's page in Gustav", () => {
  expect(codeVersionPageHref(preview())).toBe("/app/mail/m_info/code");
  expect(codeVersionPageHref(preview({ ownerKind: "person", page: null }))).toBe(`/app/assistant/code/${codeId}`);
  expect(codeVersionPageHref(preview({ page: null }))).toBeNull();
  expect(codeVersionOwnPageHref(preview())).toBeNull();
});
