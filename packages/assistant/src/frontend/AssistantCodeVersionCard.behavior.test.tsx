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
const mount = async (
  given: Routes,
  options: { onAsk?: (text: string) => void; number?: number; locale?: string; pending?: string } = {},
) => {
  // The review and the words answer like Core does for an ordinary ready version, unless a test says otherwise.
  const routes: Routes = {
    "/api/capabilities/v1/queries/core/code.read": () => ({ json: { data: { code: { state: "active", activeVersionId: "v4" } } } }),
    "/api/capabilities/v1/queries/core/code.version.read": () => ({ json: { data: { pages: { versionId, homeUrl: null, pages: [] } } } }),
    review: () => ({ json: { data: review() } }),
    [WORDS]: () => ({ json: { data: words() } }),
    ...given,
  };
  const dom = createDomTestHarness();
  const storage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: dom.window.sessionStorage });
  if (options.pending) sessionStorage.setItem(`cloud.code.activation:${codeId}:${versionId}`, options.pending);
  const calls: Array<{ route: string; body: unknown }> = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    const route = String(url).replace("/api/code/", "");
    const body = JSON.parse(String(init?.body ?? "null"));
    calls.push({ route, body });
    const answer = await routes[route]?.(body);
    if (!answer) return new Response("{}", { status: 503 });
    return new Response(JSON.stringify(answer.json ?? {}), { status: answer.status ?? 200 });
  }) as unknown as typeof fetch);
  // Browser UI modules register delegated events while loading, so await them inside this DOM lifetime.
  const { LocaleProvider } = await import("@k2b/ui");
  const { default: Card } = await import("./AssistantCodeVersionCard");
  const activated: number[] = [];
  const live = createAssistantLiveHub();
  const dispose = render(
    () => (
      <LocaleProvider locale={options.locale ?? "en"}>
        <AssistantLiveProvider value={live}>
          <Card
            codeId={codeId}
            versionId={versionId}
            number={options.number ?? 5}
            timeZone="UTC"
            onActivated={() => activated.push(1)}
            onAsk={options.onAsk}
          />
        </AssistantLiveProvider>
      </LocaleProvider>
    ),
    dom.root,
  );
  restore.push(() => {
    dispose();
    fetchSpy.mockRestore();
    if (storage) Object.defineProperty(globalThis, "sessionStorage", storage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
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
const status = (root: Element) => root.querySelector('[role="status"]')?.textContent?.trim() ?? null;
const text = (root: Element) => (root.textContent ?? "").replace(/\s+/g, " ");
/** The patterns the code-no-source rule forbids in what a person reads. */
const expectNoCode = (root: Element) => {
  const shown = text(root);
  for (const pattern of [/\bcode\.tsx?\b/i, /\.[a-z]{1,8}:\d+/i, /\bcode_[a-z_]+\b/, /\b[0-9a-f]{8,}\b/i])
    expect(shown).not.toMatch(pattern);
};

test("ready: one NoticeCard, one sentence, quiet facts and two actions; details stay on the Code page", async () => {
  const { dom, calls } = await mount({ "activation/preview": () => ({ json: { data: preview() } }) });
  const card = dom.root.querySelector(".assistant-code-version")!;
  expect(card.classList.contains("k2b-notice-card")).toBe(true);
  expect(card.getAttribute("data-chat-anchor")).toBe(`code-version-${versionId}`);
  expect(status(card)).toBe("Version 5 is ready to switch on.");
  expect(card.querySelector(".assistant-code-version__quiet")?.textContent).toContain("Code of info@");
  expect(card.querySelectorAll("button, a")).toHaveLength(2);
  expect(card.querySelector(".k2b-chat-decision__details")).toBeNull();
  expect(button(card, "See everything")?.getAttribute("href")).toBe(`/app/mail/m_info/code?tab=versions&version=${versionId}`);
  expect(calls.some((call) => call.route === "activate")).toBe(false);
  expectNoCode(card);
});

test("activation guards a double click, reloads the actual active state, and keeps one form", async () => {
  let on = false;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { dom, calls, activated } = await mount({
    "activation/preview": () => ({ json: { data: preview({ running: on ? 5 : 4 }) } }),
    "/api/capabilities/v1/queries/core/code.read": () => ({
      json: { data: { code: { state: "active", activeVersionId: on ? versionId : "v4" } } },
    }),
    activate: async () => {
      await held;
      on = true;
      return { json: { data: { state: "active", failure: null } } };
    },
    [AUTOMATIONS]: () => ({ json: { data: { items: [], removedTargets: [] } } }),
  });
  const main = button(dom.root, "Switch on")!;
  main.click();
  main.click();
  await tick();
  expect(status(dom.root)).toContain("being switched on");
  expect(calls.filter((call) => call.route === "activate")).toHaveLength(1);
  release();
  await tick();
  await tick();
  expect(status(dom.root)).toBe("Version 5 is switched on.");
  expect(activated).toEqual([1]);
  expect(button(dom.root, "Open")).toBeUndefined();
  expect(button(dom.root, "See runs")).toBeDefined();
  expect(dom.root.querySelectorAll(".assistant-code-version")).toHaveLength(1);
});

test("failure returns keyboard focus to retry without focusing it in the test; retry gets a new identity", async () => {
  const { dom, calls } = await mount({
    "activation/preview": () => ({ json: { data: preview() } }),
    activate: () => ({ json: { data: { state: "failed", failure: { reason: "changed" } } } }),
  });
  const main = dom.root.querySelector<HTMLButtonElement>("[data-code-version-primary]")!;
  main.focus();
  main.click();
  await tick();
  const retry = button(dom.root, "Try again")!;
  expect(document.activeElement).toBe(retry);
  expect(dom.root.querySelector('[role="alert"]')?.textContent).toContain("Switching on did not work.");
  retry.click();
  await tick();
  const ids = calls.filter((call) => call.route === "activate").map((call) => (call.body as { activationId: string }).activationId);
  expect(ids).toHaveLength(2);
  expect(ids[0]).not.toBe(ids[1]);
});

test("a lost response only checks Core, and an unreadable outcome offers no second activation", async () => {
  const { dom, calls } = await mount({
    "activation/preview": () => ({ json: { data: preview() } }),
    activate: () => ({ status: 503 }),
    "activation/read": () => ({ status: 503 }),
  });
  button(dom.root, "Switch on")!.click();
  await tick();
  await tick();
  expect(status(dom.root)).toContain("not yet clear");
  expect(dom.root.querySelector("[data-code-version-primary]")?.textContent).toContain("Check");
  expect(button(dom.root, "Try again")).toBeUndefined();
  expect(calls.filter((call) => call.route === "activation/read")).toHaveLength(1);
});

test("the durable pending identity is checked on reload rather than starting again", async () => {
  const { dom, calls } = await mount(
    {
      "activation/preview": () => ({ json: { data: preview() } }),
      "activation/read": () => ({ status: 503 }),
    },
    { pending: "pending-one" },
  );
  expect(calls.find((call) => call.route === "activation/read")?.body).toEqual({ codeId, activationId: "pending-one" });
  expect(calls.filter((call) => call.route === "activate")).toHaveLength(0);
  expect(status(dom.root)).toContain("not yet clear");
});

test("checking a lost activation says checking while Core has not answered", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { dom } = await mount(
    {
      "activation/preview": () => ({ json: { data: preview() } }),
      "activation/read": async () => {
        await held;
        return { status: 503 };
      },
    },
    { pending: "pending-check" },
  );
  expect(status(dom.root)).toBe("Cloud is checking the activation …");
  expect(button(dom.root, "Switch on")?.hasAttribute("disabled")).toBe(true);
  release();
  await tick();
  expect(status(dom.root)).toContain("not yet clear");
});

test("a successful activation with an older read keeps its durable identity and cannot start a second attempt", async () => {
  const { dom, calls } = await mount({
    "activation/preview": () => ({ json: { data: preview() } }),
    activate: () => ({ json: { data: { state: "active", failure: null } } }),
  });
  button(dom.root, "Switch on")!.click();
  await tick();
  await tick();
  expect(status(dom.root)).toContain("not yet clear");
  expect(button(dom.root, "Switch on")).toBeUndefined();
  expect(sessionStorage.getItem(`cloud.code.activation:${codeId}:${versionId}`)).not.toBeNull();
  expect(calls.filter((call) => call.route === "activate")).toHaveLength(1);
});

test("live decisions update in place; a failed read retains the previous decision", async () => {
  let pending = true;
  let down = false;
  const card = await mount({
    "activation/preview": () =>
      down ? { status: 503 } : { json: { data: preview({ readiness: { state: pending ? "approval_pending" : "ready" } }) } },
    review: () => ({ json: { data: review({ status: pending ? "pending" : "approved", decidedBy: JANA }) } }),
  });
  expect(status(card.dom.root)).toContain("waiting for an admin");
  await card.live.apply([decided(["conversation-detail"])]);
  expect(card.previews()).toBe(1);
  down = true;
  pending = false;
  await expect(card.live.apply([decided()])).rejects.toThrow();
  expect(status(card.dom.root)).toContain("waiting for an admin");
  down = false;
  await card.live.apply([decided()]);
  await tick();
  expect(status(card.dom.root)).toBe("Jana Probe approved version 5.");
});

test("open uses the server-projected home and other pages, and never preview route order", async () => {
  const { dom, calls } = await mount({
    "activation/preview": () => ({
      json: {
        data: preview({ running: 5, automations: [{ entrypoint: "wrong.ts", route: { method: "GET", path: "/wrong", public: false } }] }),
      },
    }),
    "/api/capabilities/v1/queries/core/code.read": () => ({ json: { data: { code: { state: "active", activeVersionId: versionId } } } }),
    "/api/capabilities/v1/queries/core/code.version.read": () => ({
      json: {
        data: {
          pages: {
            versionId,
            homeUrl: "/code/c_info01/selected",
            pages: [
              { entrypoint: "second.ts", path: "/other", title: "Other", isRoot: false, href: "/code/c_info01/other" },
              { entrypoint: "home.ts", path: "/selected", title: "Home", isRoot: true, href: "/code/c_info01/selected" },
            ],
          },
        },
      },
    }),
  });
  expect(status(dom.root)).toBe("Version 5 is switched on.");
  expect(dom.root.querySelector(".k2b-split-button")).not.toBeNull();
  expect(button(dom.root, "See runs")?.getAttribute("href")).toBe("/app/mail/m_info/code?tab=runs");
  expect(calls.find((call) => call.route.endsWith("/code.version.read"))?.body).toMatchObject({
    input: { content: { kind: "manifest" }, offset: 0, length: 1 },
  });
  expect(text(dom.root)).not.toContain("wrong.ts");
});

test("a paused code is never presented as switched on and has no Open", async () => {
  const { dom } = await mount({
    "activation/preview": () => ({ json: { data: preview({ running: 5 }) } }),
    "/api/capabilities/v1/queries/core/code.read": () => ({
      json: {
        data: {
          code: { state: "paused", activeVersionId: versionId, pausedAt: "2026-11-12T08:00:00.000Z", pausedBy: { name: "Lea Muster" } },
        },
      },
    }),
  });
  expect(status(dom.root)).toBe("Version 5 is paused.");
  expect(text(dom.root)).toContain("Lea Muster");
  expect(button(dom.root, "Open")).toBeUndefined();
  expect(button(dom.root, "Continue on the Code page")?.getAttribute("href")).toBe("/app/mail/m_info/code");
});

test("a missing operating-state query does not invent On or Open and offers recovery", async () => {
  const { dom } = await mount({
    "activation/preview": () => ({ json: { data: preview({ running: 5 }) } }),
    "/api/capabilities/v1/queries/core/code.read": () => ({ status: 503 }),
  });
  expect(status(dom.root)).toBe("The current state could not be loaded.");
  expect(button(dom.root, "Try again")).toBeDefined();
  expect(button(dom.root, "Open")).toBeUndefined();
});

test("withdrawal follows the saved status; a failure is announced in its own alert", async () => {
  let withdrawn = false;
  let fail = true;
  const { dom } = await mount({
    "activation/preview": () => ({ json: { data: preview({ readiness: { state: "approval_pending" } }) } }),
    review: () => ({ json: { data: review({ status: withdrawn ? "withdrawn" : "pending" }) } }),
    withdraw: () => {
      if (fail) return { status: 503 };
      withdrawn = true;
      return { json: { data: {} } };
    },
  });
  button(dom.root, "Withdraw")!.click();
  await tick();
  expect(dom.root.querySelector(".assistant-code-version__quiet [role=alert]")?.textContent).toContain("withdraw");
  fail = false;
  button(dom.root, "Withdraw")!.click();
  await tick();
  await tick();
  expect(status(dom.root)).toBe("Version 5 was withdrawn.");
});

test("requested changes and rejection send the existing conversation requests, without dumping comments", async () => {
  for (const state of ["changes_requested", "rejected"] as const) {
    const asked: string[] = [];
    const { dom } = await mount(
      {
        "activation/preview": () => ({ json: { data: preview() } }),
        review: () => ({ json: { data: review({ status: state, decidedBy: JANA, message: "Only PDF attachments.", commentCount: 2 }) } }),
      },
      { onAsk: (value) => asked.push(value) },
    );
    expect(text(dom.root)).toContain("Only PDF attachments.");
    button(dom.root, state === "rejected" ? "Build differently" : "Let Gustav revise")!.click();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("version 5");
    for (const undo of restore.splice(0)) undo();
  }
});

test("automatic revision offers only Stop, and a late stop names the actual submitted version", async () => {
  const { dom, calls } = await mount(
    {
      "activation/preview": () => ({ json: { data: preview() } }),
      review: () => ({ json: { data: review({ status: "changes_requested", revision: { state: "running", reason: null } }) } }),
      "authoring/reviewStop": () => ({ json: { status: "too_late", submittedVersionId: "next", submittedNumber: 6 } }),
    },
    { onAsk: () => {} },
  );
  expect(status(dom.root)).toContain("once by himself");
  expect(button(dom.root, "Let Gustav revise")).toBeUndefined();
  button(dom.root, "Stop")!.click();
  await tick();
  await tick();
  expect(calls.some((call) => call.route === "authoring/reviewStop")).toBe(true);
  expect(text(dom.root)).toContain("Version 6 had already been submitted");
});

test("asking again follows the new version under the original chat anchor", async () => {
  const next = "88888888-8888-4888-8888-888888888888";
  const { dom, calls } = await mount({
    "activation/preview": (body) => ({
      json: {
        data: preview(
          (body as { versionId: string }).versionId === next
            ? { versionId: next, number: 6, latest: 6, readiness: { state: "approval_pending" } }
            : {},
        ),
      },
    }),
    review: (body) => ({ json: { data: review({ status: (body as { versionId: string }).versionId === next ? "pending" : "expired" }) } }),
    "authoring/reviewRequestAgain": () => ({ json: { version: { id: next, number: 6 } } }),
  });
  button(dom.root, "Ask again")!.click();
  await tick();
  await tick();
  expect(status(dom.root)).toContain("Version 6 is waiting");
  expect(dom.root.querySelector("[data-chat-anchor]")?.getAttribute("data-chat-anchor")).toBe(`code-version-${versionId}`);
  expect(calls.filter((call) => call.route === "activation/preview").at(-1)?.body).toMatchObject({ versionId: next });
});

test("a replaced card links to the actual new version ID", async () => {
  const { dom } = await mount({
    "activation/preview": () => ({ json: { data: preview({ latest: 6 }) } }),
    "/api/capabilities/v1/queries/core/code.version.list": () => ({
      json: { data: { items: [{ version: { id: "actual-next", number: 6 } }] } },
    }),
  });
  expect(status(dom.root)).toBe("Version 5 was replaced by version 6.");
  expect(button(dom.root, "Go to version 6")?.getAttribute("href")).toContain("version=actual-next");
});

test("the owner declares the Code page; personal Code uses Gustav's public page", () => {
  expect(codeVersionPageHref(preview())).toBe("/app/mail/m_info/code");
  expect(codeVersionPageHref(preview({ ownerKind: "person", page: null }))).toBe(`/app/assistant/code/${codeId}`);
  expect(codeVersionPageHref(preview({ page: null }))).toBeNull();
  expect(codeVersionOwnPageHref(preview())).toBeNull();
});
