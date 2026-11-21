import { afterAll, afterEach, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { type CodeVersionCardSnapshot, codeVersionCardsContract } from "@k2b/cloud/contracts/code-version-cards";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { AssistantLiveProvider, createAssistantLiveHub } from "./assistant-live";
import { approvalNow, approvalSnapshot, approvalVersionId } from "./code-version-card.test-fixture";
import { createCodeVersionCardStore } from "./code-version-card-store";

beforeAll(() => setSystemTime(new Date(approvalNow)));
afterAll(() => setSystemTime());
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const restore: Array<() => void> = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});
const ref = { codeId: "c_info01", versionId: approvalVersionId };
const event = (codeId = ref.codeId) => ({
  type: "ai.invalidated" as const,
  changeId: "77777777-7777-4777-8777-777777777777",
  conversationId: null,
  projectId: null,
  domains: ["code-versions" as const],
  codeId,
  at: "2026-11-17T08:30:00.000Z",
});
const button = (root: Element, text: string) =>
  [...root.querySelectorAll<HTMLElement>("button,a")].find((element) => element.textContent?.includes(text));
const status = (root: Element) => root.querySelector('[role="status"]')?.textContent ?? "";
type ActivationAnswer = { state: string; failure: null };
const mount = async (
  options: {
    snapshot?: () => CodeVersionCardSnapshot;
    readFails?: () => boolean;
    denied?: () => boolean;
    initial?: CodeVersionCardSnapshot;
    count?: number;
    activate?: () => Promise<ActivationAnswer>;
    activationReadFails?: boolean;
    pending?: string;
    mutate?: (path: string) => unknown;
  } = {},
) => {
  const dom = createDomTestHarness();
  const storage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: dom.window.sessionStorage });
  if (options.pending) sessionStorage.setItem(`cloud.code.activation:${ref.codeId}:${ref.versionId}`, options.pending);
  const refs = Array.from({ length: options.count ?? 1 }, (_, index) =>
    options.count ? { ...ref, versionId: `${ref.versionId.slice(0, -1)}${index + 1}` } : ref,
  );
  const asked: string[] = [];
  const calls: Array<{ path: string; body: unknown }> = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    const path = String(url),
      body = JSON.parse(String(init?.body ?? "null"));
    calls.push({ path, body });
    if (path.endsWith("/code.version.cards")) {
      if (options.readFails?.()) return new Response("{}", { status: 503 });
      const snapshot = options.snapshot?.() ?? approvalSnapshot("ready", "en");
      const input = codeVersionCardsContract.input.parse(body.input);
      return Response.json({
        data: {
          items: input.versions.map((version) =>
            options.denied?.()
              ? { ...version, state: "denied" }
              : {
                  ...version,
                  state: "available",
                  snapshot: {
                    ...snapshot,
                    preview: { ...snapshot.preview, ...version },
                    pages: snapshot.pages ? { ...snapshot.pages, versionId: version.versionId } : snapshot.pages,
                  },
                },
          ),
        },
      });
    }
    if (path.endsWith("/activate")) return Response.json({ data: (await options.activate?.()) ?? { state: "failed", failure: null } });
    if (path.endsWith("/activation/read"))
      return options.activationReadFails
        ? new Response("{}", { status: 503 })
        : Response.json({ data: { state: "failed", failure: null } });
    if (options.mutate) return Response.json(options.mutate(path));
    throw new Error(`Unexpected card read ${path}`);
  }) as typeof fetch);
  const { LocaleProvider } = await import("@k2b/ui");
  const { default: Card } = await import("./AssistantCodeVersionCard");
  const live = createAssistantLiveHub();
  const dispose = render(() => {
    const store = createCodeVersionCardStore(live, options.initial ? [{ ...ref, state: "available", snapshot: options.initial }] : []);
    return (
      <LocaleProvider locale="en">
        <AssistantLiveProvider value={live}>
          {refs.map((version) => (
            <Card {...version} number={1} timeZone="UTC" store={store} onAsk={(message) => asked.push(message)} />
          ))}
          <button id="elsewhere">Elsewhere</button>
        </AssistantLiveProvider>
      </LocaleProvider>
    );
  }, dom.root);
  restore.push(() => {
    dispose();
    fetchSpy.mockRestore();
    if (storage) Object.defineProperty(globalThis, "sessionStorage", storage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
    dom.cleanup();
  });
  await tick();
  return { dom, calls, live, asked, reads: () => calls.filter((call) => call.path.endsWith("/code.version.cards")) };
};

test("N cards share one mount batch and skip unrelated invalidations; all matching events in a batch are retained", async () => {
  const card = await mount({ count: 3 });
  expect(card.reads()).toHaveLength(1);
  expect(codeVersionCardsContract.input.parse((card.reads()[0]?.body as { input: unknown }).input).versions).toHaveLength(3);
  await card.live.apply([event("c_other1")]);
  expect(card.reads()).toHaveLength(1);
  await card.live.apply([event("c_other1"), event()]);
  expect(card.reads()).toHaveLength(2);
  expect(card.dom.root.querySelectorAll("[data-approval-frame]")).toHaveLength(3);
  expect(card.calls.every((call) => !call.path.endsWith("/code.read"))).toBe(true);
});
test("the server snapshot is the initial card and mounting performs no read", async () => {
  const card = await mount({ initial: approvalSnapshot("on", "en") });
  expect(status(card.dom.root)).toBe("Version 1 is switched on.");
  expect(card.reads()).toHaveLength(0);
  expect(button(card.dom.root, "Open")).toBeDefined();
});
test("status refresh reuses the same immutable pages and rechecks revocation", async () => {
  const initial = approvalSnapshot("on", "en");
  const update = { ...initial, pages: undefined };
  let denied = false;
  const card = await mount({ initial, snapshot: () => update, denied: () => denied });
  await card.live.apply([event()]);
  expect(card.reads()[0]?.body).toMatchObject({ input: { knownPages: [ref.versionId] } });
  expect(button(card.dom.root, "Open")).toBeDefined();
  denied = true;
  await card.live.apply([event()]);
  expect(button(card.dom.root, "Open")).toBeUndefined();
  expect(status(card.dom.root)).toContain("no longer manage");
});
test("reader and administrative reader snapshots offer details without activation or editor mutations", async () => {
  for (const permission of ["reader", "editor"] as const) {
    const snapshot = { ...approvalSnapshot("ready", "en"), permission, canActivate: false, canManage: false };
    const card = await mount({ initial: snapshot });
    expect(button(card.dom.root, "Switch on")).toBeUndefined();
    expect(button(card.dom.root, "See everything")).toBeDefined();
    for (const undo of restore.splice(0)) undo();
  }
});
test("activation guards double clicks, then loads the active version and its pages in the existing batch path", async () => {
  let on = false,
    release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const card = await mount({
    snapshot: () => approvalSnapshot(on ? "on" : "ready", "en"),
    activate: async () => {
      await held;
      on = true;
      return { state: "active", failure: null };
    },
  });
  const primary = button(card.dom.root, "Switch on")!;
  primary.click();
  primary.click();
  await tick();
  expect(card.calls.filter((call) => call.path.endsWith("/activate"))).toHaveLength(1);
  release();
  await tick();
  await tick();
  expect(status(card.dom.root)).toBe("Version 1 is switched on.");
  expect(button(card.dom.root, "Open")).toBeDefined();
});
test("a confirmed activation with unavailable pages offers focused recovery instead of treating them as empty", async () => {
  let active = false;
  const card = await mount({
    snapshot: () => ({ ...approvalSnapshot(active ? "on" : "ready", "en"), ...(active ? { pages: null } : {}) }),
    activate: async () => {
      active = true;
      return { state: "active", failure: null };
    },
  });
  const primary = button(card.dom.root, "Switch on")!;
  primary.focus();
  primary.click();
  await tick();
  await tick();
  expect(status(card.dom.root)).toBe("Version 1 is switched on.");
  expect(button(card.dom.root, "Open")).toBeUndefined();
  expect(document.activeElement).toBe(button(card.dom.root, "Try again")!);
  expect(card.dom.root.querySelector('.k2b-notice-card__description [role="alert"]')?.textContent).toMatch(/could not/i);
});

test("a lost activation response reconciles its durable identity and never offers a second activation", async () => {
  const card = await mount({
    activate: async () => {
      throw new Error("lost response");
    },
    activationReadFails: true,
  });
  button(card.dom.root, "Switch on")!.click();
  await tick();
  await tick();
  expect(status(card.dom.root)).toContain("not yet clear");
  expect(button(card.dom.root, "Switch on")).toBeUndefined();
  expect(card.calls.filter((call) => call.path.endsWith("/activate"))).toHaveLength(1);
  expect(sessionStorage.getItem(`cloud.code.activation:${ref.codeId}:${ref.versionId}`)).not.toBeNull();
});
test("reload checks a pending activation instead of submitting it again", async () => {
  const card = await mount({ pending: "pending-one", activationReadFails: true });
  expect(card.calls.find((call) => call.path.endsWith("/activation/read"))?.body).toEqual({
    codeId: ref.codeId,
    activationId: "pending-one",
  });
  expect(card.calls.filter((call) => call.path.endsWith("/activate"))).toHaveLength(0);
});
test("a failed live/page read is visible with recovery and is not acknowledged; a real empty list remains valid", async () => {
  let down = false;
  const card = await mount({
    initial: approvalSnapshot("on", "en"),
    readFails: () => down,
    snapshot: () => approvalSnapshot("on-without-page", "en"),
  });
  down = true;
  await expect(card.live.apply([event()])).rejects.toThrow();
  expect(card.dom.root.querySelector('.k2b-notice-card__description [role="alert"]')?.textContent).toMatch(/could not/i);
  expect(button(card.dom.root, "Try again")).toBeDefined();
  down = false;
  button(card.dom.root, "Try again")!.click();
  await tick();
  expect(button(card.dom.root, "Open")).toBeUndefined();
  expect(button(card.dom.root, "See runs")).toBeDefined();
});

for (const moveFocus of [false, true])
  test(`activation focus follows the new primary unless moved deliberately (${moveFocus})`, async () => {
    let on = false,
      release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const card = await mount({
      snapshot: () => approvalSnapshot(on ? "on" : "ready", "en"),
      activate: async () => {
        await held;
        on = true;
        return { state: "active", failure: null };
      },
    });
    const primary = button(card.dom.root, "Switch on")!;
    primary.focus();
    primary.click();
    await tick();
    if (moveFocus) card.dom.root.querySelector<HTMLElement>("#elsewhere")!.focus();
    release();
    await tick();
    await tick();
    expect(document.activeElement).toBe(
      moveFocus ? card.dom.root.querySelector("#elsewhere") : card.dom.root.querySelector("[data-code-version-primary]"),
    );
  });

test("a confirmed activation with stale state keeps its durable identity and offers only reconciliation", async () => {
  const card = await mount({ activate: async () => ({ state: "active", failure: null }) });
  button(card.dom.root, "Switch on")!.click();
  await tick();
  await tick();
  expect(status(card.dom.root)).toContain("not yet clear");
  expect(button(card.dom.root, "Switch on")).toBeUndefined();
  expect(sessionStorage.getItem(`cloud.code.activation:${ref.codeId}:${ref.versionId}`)).not.toBeNull();
});

test("withdrawal refreshes the receipt and a failed mutation stays visible and retryable", async () => {
  let withdrawn = false,
    fails = true;
  const snapshot = () => {
    const value = approvalSnapshot("waiting", "en");
    if (withdrawn) value.review!.status = "withdrawn";
    return value;
  };
  const card = await mount({
    snapshot,
    mutate: (path) => {
      expect(path.endsWith("/withdraw")).toBe(true);
      if (fails) throw new Error("offline");
      withdrawn = true;
      return { withdrawn: true };
    },
  });
  button(card.dom.root, "Withdraw")!.click();
  await tick();
  expect(card.dom.root.querySelector('.k2b-notice-card__description [role="alert"]')?.textContent).toMatch(/could not/i);
  fails = false;
  button(card.dom.root, "Withdraw")!.click();
  await tick();
  expect(status(card.dom.root)).toContain("withdrawn");
});

for (const state of ["changes", "rejected"] as const)
  test(`${state} sends the existing conversation request`, async () => {
    const card = await mount({ initial: approvalSnapshot(state, "en") });
    button(card.dom.root, state === "changes" ? "revise" : "differently")!.click();
    expect(card.asked).toHaveLength(1);
    expect(card.asked[0]).toContain("1");
    expect(card.reads()).toHaveLength(0);
  });

test("a late revision stop names the actually submitted version", async () => {
  const card = await mount({
    snapshot: () => approvalSnapshot("revising", "en"),
    mutate: (path) => {
      expect(path.endsWith("/authoring/reviewStop")).toBe(true);
      return { status: "too_late", submittedNumber: 2 };
    },
  });
  button(card.dom.root, "Stop")!.click();
  await tick();
  expect(card.dom.root.querySelector('.k2b-notice-card__description [role="alert"]')?.textContent).toContain("2");
});
