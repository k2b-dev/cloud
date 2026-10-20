import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Locator, Page, Request } from "playwright";
import { z } from "zod";
import { TIMEZONE_COOKIE } from "../../../../packages/cloud/src/shared/time";
import { measureStatic } from "../../../../scripts/perf-baseline/assets";
import { Browsers, type LoadTiming, measuredLocale, measuredTimeZone, profiles } from "../../../../scripts/perf-baseline/browser";
import { validatePage } from "../../../../scripts/perf-baseline/model";
import { buildRoot, localTls, type Runtime, repository } from "../../../../scripts/perf-baseline/runtime";
import type { Api } from "../../../../scripts/perf-baseline/seed";
import { mailDraftSeedSchema } from "../../src/contracts";
import { mailDraftSeedKey } from "../../src/frontend/_components/mail-draft-seed-store";
import { buildMailSearchHref } from "../../src/frontend/_components/mail-navigation";
import type { LargeMailboxPlan } from "../../test/fixtures/large-mailbox";
import { Arrival } from "./arrival";
import {
  type BrowserSection,
  type Engine,
  type InteractionId,
  type InteractionProfile,
  type InteractionSample,
  type InteractionTrace,
  interactionRequestSizes,
  interactionRequestTiming,
  interactionSample,
  interactions,
  interactionTraceBreakdown,
  islandRenderMs,
  type LoadPage,
  type LoadProfile,
  type LoadSample,
  summarizeInteraction,
  summarizeLoads,
  syncMark,
  traceBreakdown,
} from "./browser-model";
import { monotonicMs } from "./measure";
import { draftSeedBodies } from "./requests";

type Profile = (typeof profiles)[number];
/** framesReported: every iframe inside reported its laid-out height (the HTML message frame does after its body). */
type Condition = {
  selector: string;
  text?: string;
  visible?: boolean;
  writable?: boolean;
  mounted?: boolean;
  framesReported?: boolean;
  path?: string;
  interactive?: boolean;
};
/** pointerdown/enter: the trusted input event; mark: the page calls __mailPerfMark; external: the host supplies t0. */
type Watch = { id: string; conditions: Condition[]; action: "pointerdown" | "enter" | "mark" | "external" };
type WatchState = Watch & { actionAt: number | null; inputAt: number | null; hitAt: number | null; mountWindows: [number, number][] };
declare global {
  interface Window {
    __mailPerfArm?: (watch: Watch) => boolean;
    __mailPerfMark?: () => void;
  }
}

export const watchKey = "cloud-mail-perf-watch";
/** Uncaught errors, rejections and island errors of every top-level document of the sample. */
export const errorsKey = `${watchKey}:errors`;
const interactionTimeoutMs = 30_000;
const sampleTimeoutMs = 120_000;
const unsettledMs = 10_000;
/** Mirrors the quick-search debounce in packages/mail/src/frontend/_components/MailConversationList.tsx. */
const searchDebounceMs = 300;
/** Host request events trail the browser; candidates come from this margin around the window. */
const clockSlackMs = 1_000;
const traceCategories = ["devtools.timeline", "disabled-by-default-devtools.timeline", "v8", "blink.user_timing", "toplevel"];

/**
 * Runs in every document of an interaction page. The armed watch lives in sessionStorage so
 * it survives full navigations (compose). Each animation frame checks the end state; the
 * time is taken in the frame callback that paints it. Times are epoch ms, comparable with
 * the host clock because the browser container shares the host kernel clock.
 */
export function installInteractionProbe({ key, trace = false }: { key: string; trace?: boolean }) {
  // Init scripts also run in child frames; a sandboxed message iframe has no storage access,
  // and Playwright's service worker block throws there. Only the app's own document counts.
  if (window !== window.top) return;
  // Errors live in sessionStorage too, so an error in the start document still fails the
  // sample after the action navigated to another document (compose).
  const fail = (message: string) => {
    const errors = JSON.parse(sessionStorage.getItem(`${key}:errors`) ?? "[]") as string[];
    sessionStorage.setItem(`${key}:errors`, JSON.stringify([...errors, message]));
  };
  addEventListener("error", (event) => {
    if (event instanceof ErrorEvent) fail(event.message);
  });
  window.addEventListener("unhandledrejection", (event) => fail(`Unhandled rejection: ${String(event.reason)}`));
  document.addEventListener("ssr:island-error", () => fail("ssr:island-error"));
  const now = () => performance.timeOrigin + performance.now();
  const read = (): WatchState | null => {
    const value = sessionStorage.getItem(key);
    return value ? (JSON.parse(value) as WatchState) : null;
  };
  const write = (state: WatchState) => sessionStorage.setItem(key, JSON.stringify(state));
  // A message frame posts its height once its body is laid out (mail-message-document.ts).
  const reported = new WeakSet<object>();
  addEventListener(
    "message",
    (event) => {
      const data: unknown = event.data;
      if (event.source && typeof data === "object" && data !== null && "source" in data && "type" in data)
        if (data.source === "cloud-mail-message" && data.type === "height") reported.add(event.source);
    },
    { capture: true },
  );
  const mountWindows = (): [number, number][] =>
    [...(window.__cloudPerf?.mounted ?? [])].flatMap(([island, end]): [number, number][] => {
      const start = window.__cloudPerf?.started.get(island);
      return start === undefined ? [] : [[performance.timeOrigin + start, performance.timeOrigin + end]];
    });
  addEventListener("pagehide", () => {
    const state = read();
    if (trace && state && state.hitAt === null) write({ ...state, mountWindows: [...state.mountWindows, ...mountWindows()] });
  });
  const holds = (condition: Condition) => {
    if (condition.path !== undefined && window.location.pathname !== condition.path) return false;
    for (const element of document.querySelectorAll(condition.selector)) {
      if (condition.text !== undefined && !(element.textContent ?? "").includes(condition.text)) continue;
      if (condition.writable) {
        const writable =
          element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
            ? !element.disabled && !element.readOnly
            : element instanceof HTMLElement && element.isContentEditable;
        if (!writable) continue;
      }
      if (
        condition.framesReported &&
        ![...element.querySelectorAll("iframe")].every((frame) => frame.contentWindow && reported.has(frame.contentWindow))
      )
        continue;
      if (condition.interactive && element.closest('[aria-busy="true"]')) continue;
      if (condition.mounted || condition.interactive) {
        const island = element.closest("solid-island,solid-client");
        if (!island || !window.__cloudPerf?.mounted.has(island)) continue;
      }
      if (condition.visible) {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0) continue;
        if (rect.top >= innerHeight || rect.left >= innerWidth || getComputedStyle(element).visibility === "hidden") continue;
      }
      return true;
    }
    return false;
  };
  const matches = (watch: Watch) => watch.conditions.every(holds);
  const loop = () =>
    requestAnimationFrame(function tick() {
      const state = read();
      if (!state || state.hitAt !== null) return;
      if (state.action !== "external" && state.actionAt === null) {
        requestAnimationFrame(tick);
        return;
      }
      if (matches(state)) {
        state.hitAt = now();
        if (trace) state.mountWindows.push(...mountWindows());
        write(state);
      } else requestAnimationFrame(tick);
    });
  addEventListener(
    "pointerdown",
    (event) => {
      if (!event.isTrusted) return;
      const state = read();
      if (!state || state.action !== "pointerdown" || state.actionAt !== null || state.hitAt !== null) return;
      state.actionAt = performance.timeOrigin + event.timeStamp;
      write(state);
    },
    { capture: true },
  );
  window.addEventListener(
    "keydown",
    (event) => {
      if (!event.isTrusted || event.key !== "Enter") return;
      const state = read();
      if (!state || state.action !== "enter" || state.actionAt !== null || state.hitAt !== null) return;
      state.actionAt = performance.timeOrigin + event.timeStamp;
      write(state);
    },
    { capture: true },
  );
  addEventListener(
    "input",
    (event) => {
      if (!event.isTrusted) return;
      const state = read();
      if (!state || state.actionAt !== null) return;
      state.inputAt = performance.timeOrigin + event.timeStamp;
      write(state);
    },
    { capture: true },
  );
  window.__mailPerfArm = (watch) => {
    // An end state that already holds cannot be caused by the coming action.
    if (matches(watch)) return false;
    write({ ...watch, actionAt: null, inputAt: null, hitAt: null, mountWindows: [] });
    loop();
    return true;
  };
  window.__mailPerfMark = () => {
    const state = read();
    if (state && state.action === "mark" && state.actionAt === null) {
      state.actionAt = now();
      write(state);
    }
  };
  if (read()?.hitAt === null) loop();
}

const listSchema = z.object({
  nextListCursor: z.string().nullable(),
  listItems: z.array(
    z.object({ id: z.string(), conversationId: z.string().nullable(), selectionKind: z.enum(["conversation", "message"]) }),
  ),
});
type ListItem = z.infer<typeof listSchema>["listItems"][number];
const detailSchema = z.object({
  detailMessages: z.array(
    z.object({ id: z.string(), hydrationStatus: z.string(), plainText: z.string().nullable(), sanitizedHtml: z.string().nullable() }),
  ),
});
const rowSelector = (item: ListItem) =>
  item.selectionKind === "message" || !item.conversationId
    ? `[data-mail-conversation-list] [data-message-id="${item.id}"]`
    : `[data-mail-conversation-list] [data-conversation-id="${item.conversationId}"]`;

type Setup = {
  signal: AbortSignal;
  runtime: Runtime;
  api: Api;
  plan: LargeMailboxPlan;
  fixture: { remoteResourceId: string; inboxId: string; senderIdentityId: string };
  mailbox: { shortId: string; uuid: string };
  mailboxB: { shortId: string };
  interactions: InteractionId[];
  loads: LoadPage[];
  nextUid: () => number;
};
type Recorded = { request: Request; at: number };
type LoadTarget = { path: string; storage: { key: string; value: string } | null; ready: string };
const composeEditor = 'textarea[aria-label="Message body"]';
/** act resolves to the host epoch t0 for external actions, or null when the page observed the input event. */
type Prepared = { startPath: string; act: (page: Page, profile: Profile) => Promise<number | null> };

/** Rejects after `ms` without leaving a timer or a later rejection behind. */
async function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  promise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class MailBrowser {
  constructor(
    private readonly setup: Setup,
    private readonly browsers: Browsers,
  ) {}

  private get base() {
    return `/app/mail/${this.setup.mailbox.shortId}`;
  }
  private get inbox() {
    return `${this.base}?folder=${this.setup.plan.shape.largeFolderId}`;
  }
  private async route(href: string, mailbox: { shortId: string } = this.setup.mailbox) {
    return listSchema.parse(
      await this.setup.api.request(`/api/mail/mailboxes/${mailbox.shortId}/workspace-route?href=${encodeURIComponent(href)}`),
    );
  }
  private async first(href: string, mailbox: { shortId: string } = this.setup.mailbox) {
    const item = (await this.route(href, mailbox)).listItems[0];
    if (!item) throw new Error(`Fixture list is empty: ${href}`);
    return item;
  }
  /**
   * The fixture's first custom folder: live arrivals land in the Inbox, sort above the fixture
   * and are envelopes only, so after many runs the Inbox's first page has no body to render.
   */
  private get readerFolder() {
    return `${this.base}?folder=${this.setup.plan.shape.mediumFolderId}`;
  }
  /** The reader folder's first conversation whose newest message has its body. */
  private async hydratedConversation() {
    for (const row of (await this.route(this.readerFolder)).listItems) {
      if (!row.conversationId) continue;
      const detail = detailSchema.parse(
        await this.setup.api.request(`/api/mail/mailboxes/${this.setup.mailbox.shortId}/workspace-detail/${row.conversationId}`),
      );
      const newest = detail.detailMessages.at(-1);
      if ((newest?.hydrationStatus === "complete" || newest?.hydrationStatus === "body") && (newest.plainText || newest.sanitizedHtml))
        return { row, newest: newest.id };
    }
    throw new Error("No conversation on the reader folder's first page has a message body");
  }
  /**
   * A fresh draft seed: the compose page reads it from the browser's localStorage, where
   * Compose stores it before navigating, so a measured load installs it the same way.
   */
  private async composeTarget(): Promise<LoadTarget> {
    const body = draftSeedBodies(this.setup.fixture.senderIdentityId, this.setup.plan.messages[0]!)[0]!;
    const seed = mailDraftSeedSchema.parse(
      await this.setup.api.request(`/api/mail/mailboxes/${this.setup.mailbox.shortId}/draft-seeds`, "POST", body),
    );
    return {
      path: `${this.base}/compose/local/${seed.id}?return=${encodeURIComponent(this.base)}`,
      storage: { key: mailDraftSeedKey(seed.mailboxId, seed.id), value: JSON.stringify(seed) },
      ready: composeEditor,
    };
  }
  private target(page: LoadPage): Promise<LoadTarget> {
    return page === "mailbox"
      ? Promise.resolve({ path: this.base, storage: null, ready: "[data-mail-conversation-list] [data-conversation-id]" })
      : this.composeTarget();
  }
  /** Installs the target's local state before navigation. */
  private static async prepareLoad(page: Page, target: LoadTarget) {
    if (target.storage) await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), target.storage);
  }
  /** A load only counts when the page shows what it is for, not an error or empty state. */
  private static async requireReady(page: Page, target: LoadTarget) {
    if (!(await page.locator(target.ready).filter({ visible: true }).count()))
      throw new Error(`Page is interactive but does not show ${target.ready}`);
  }

  /** A link that is visible now; on phones the navigation sits behind the app menu. */
  private async reveal(page: Page, profile: Profile, selector: string, phoneSelector = selector): Promise<Locator> {
    const link = page
      .locator(profile === "phone" ? phoneSelector : selector)
      .filter({ visible: true })
      .first();
    if ((await link.count()) === 0 && profile === "phone")
      await page.getByRole("button", { name: "Open apps", exact: true }).tap({ timeout: interactionTimeoutMs });
    await link.waitFor({ state: "visible", timeout: interactionTimeoutMs });
    return link;
  }
  private press = (profile: Profile, locator: Locator) =>
    profile === "phone" ? locator.tap({ timeout: interactionTimeoutMs }) : locator.click({ timeout: interactionTimeoutMs });

  /** Host-side expectations from the same workspace API the client uses, prepared before each sample. */
  async prepare(id: InteractionId, live: { ready: Promise<void> }): Promise<Prepared> {
    const shape = this.setup.plan.shape;
    switch (id) {
      case "mailbox-switch": {
        const mailbox = this.setup.mailboxB;
        const target = `/app/mail/${mailbox.shortId}`;
        const row = await this.first(target, mailbox);
        return {
          startPath: this.inbox,
          act: async (page, profile) => {
            const link = await this.reveal(
              page,
              profile,
              `.mail-sidebar-mailbox[data-mailbox="${mailbox.shortId}"] a[href="${target}"]`,
              `dialog a[href="${target}"]`,
            );
            await this.arm(page, {
              id,
              action: "pointerdown",
              conditions: [{ selector: rowSelector(row), visible: true, path: target, interactive: true }],
            });
            await this.press(profile, link);
            return null;
          },
        };
      }
      case "folder-switch": {
        // The first custom folder sits at the top level of the folder tree on every profile;
        // Archive is behind the collapsed More group on desktop.
        const folder = this.setup.plan.folders.find((candidate) => candidate.id === shape.mediumFolderId);
        if (!folder) throw new Error("Fixture has no medium folder");
        const target = `${this.base}?folder=${folder.id}`;
        const row = await this.first(target);
        return {
          startPath: this.inbox,
          act: async (page, profile) => {
            const link = await this.reveal(page, profile, `a[href="${target}"]`);
            await this.arm(page, {
              id,
              action: "pointerdown",
              conditions: [
                { selector: "[data-mail-list-heading]", text: folder.name },
                { selector: rowSelector(row), visible: true },
              ],
            });
            await this.press(profile, link);
            return null;
          },
        };
      }
      case "conversation-open": {
        const { row, newest } = await this.hydratedConversation();
        return {
          startPath: this.readerFolder,
          act: async (page, profile) => {
            const link = page
              .locator(`${rowSelector(row)} a`)
              .filter({ visible: true })
              .first();
            await link.waitFor({ timeout: interactionTimeoutMs });
            await this.arm(page, {
              id,
              action: "pointerdown",
              // The body itself, not the loading placeholder of a message without one.
              conditions: [
                { selector: `[data-mail-message-id="${newest}"] .mail-message-body`, visible: true, framesReported: true },
                { selector: `[data-mail-message-id="${newest}"] [data-mail-body-format]` },
              ],
            });
            await this.press(profile, link);
            return null;
          },
        };
      }
      case "conversation-open-large": {
        /**
         * Exact subject search isolates conversation 0 on page 1 without scrolling, even
         * when its date ranks below other done threads. Inbox live arrivals have different
         * subjects, so they cannot displace this row after repeated samples.
         */
        const subject = this.setup.plan.messages.find((message) => message.conversation === shape.largestThreadId)?.subject;
        if (!subject) throw new Error(`${id}: fixture thread ${shape.largestThreadId} has no subject`);
        const start = buildMailSearchHref(new URL(this.base, this.setup.api.origin), {
          search: JSON.stringify({ expression: { type: "text", field: "subject", query: subject, match: "exact" }, sort: "newest" }),
        });
        const row = (await this.route(start)).listItems.find(
          (item) => item.selectionKind === "conversation" && item.conversationId === shape.largestThreadId,
        );
        if (!row) throw new Error(`${id}: thread ${shape.largestThreadId} is missing from page 1 of ${start}`);
        const detail = detailSchema.parse(
          await this.setup.api.request(`/api/mail/mailboxes/${this.setup.mailbox.shortId}/workspace-detail/${shape.largestThreadId}`),
        );
        const newest = detail.detailMessages.at(-1);
        if (
          !newest ||
          (newest.hydrationStatus !== "complete" && newest.hydrationStatus !== "body") ||
          !(newest.plainText || newest.sanitizedHtml)
        )
          throw new Error(`${id}: newest message of thread ${shape.largestThreadId} has no body`);
        return {
          startPath: start,
          act: async (page, profile) => {
            const link = page
              .locator(`${rowSelector(row)} a`)
              .filter({ visible: true })
              .first();
            await link.waitFor({ timeout: interactionTimeoutMs });
            await this.arm(page, {
              id,
              action: "pointerdown",
              conditions: [
                { selector: `[data-mail-message-id="${newest.id}"] .mail-message-body`, visible: true, framesReported: true },
                { selector: `[data-mail-message-id="${newest.id}"] [data-mail-body-format]` },
              ],
            });
            await this.press(profile, link);
            return null;
          },
        };
      }
      case "list-scroll": {
        const cursor = (await this.route(this.inbox)).nextListCursor;
        if (!cursor) throw new Error("Inbox has no second page; seed more conversations");
        const row = await this.first(`${this.inbox}&cursor=${encodeURIComponent(cursor)}`);
        return {
          startPath: this.inbox,
          act: async (page) => {
            await page.locator("[data-mail-conversation-list] [data-conversation-id]").first().waitFor({ timeout: interactionTimeoutMs });
            await this.arm(page, { id, action: "mark", conditions: [{ selector: rowSelector(row) }] });
            await page.evaluate(() => {
              const row = document.querySelector("[data-mail-conversation-list] [data-conversation-id]");
              let scroller = row?.parentElement ?? null;
              while (
                scroller &&
                !(scroller.scrollHeight > scroller.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))
              )
                scroller = scroller.parentElement;
              const target = scroller ?? document.scrollingElement;
              if (!target) throw new Error("No scroll container for the conversation list");
              window.__mailPerfMark?.();
              target.scrollTop = target.scrollHeight;
            });
            return null;
          },
        };
      }
      case "search-submit": {
        const href = buildMailSearchHref(new URL(this.base, this.setup.api.origin), { q: shape.rareWord });
        const row = await this.first(href);
        return {
          startPath: this.base,
          act: async (page) => {
            const input = page.locator('input[name="q"]').filter({ visible: true }).first();
            await input.waitFor({ timeout: interactionTimeoutMs });
            await this.arm(page, {
              id,
              action: "enter",
              conditions: [
                { selector: "[data-mail-list-heading]", text: shape.rareWord },
                { selector: rowSelector(row), visible: true },
              ],
            });
            // One driver call types the word and presses Enter, so no host round trip sits
            // between the last input event and the submit.
            await input.pressSequentially(`${shape.rareWord}\n`, { timeout: interactionTimeoutMs });
            return null;
          },
        };
      }
      case "live-arrival": {
        return {
          startPath: this.inbox,
          act: async (page) => {
            await within(live.ready, interactionTimeoutMs, "Mail live subscription did not become ready");
            const uid = this.setup.nextUid();
            await this.arm(page, {
              id,
              action: "external",
              conditions: [
                { selector: "[data-mail-conversation-list] [data-conversation-id]", text: `Live arrival ${uid}`, visible: true },
              ],
            });
            const arrival = new Arrival({
              signal: this.setup.signal,
              runtime: this.setup.runtime,
              origin: this.setup.api.origin,
              mailboxId: this.setup.mailbox.uuid,
              remoteResourceId: this.setup.fixture.remoteResourceId,
              folderId: this.setup.fixture.inboxId,
              uid,
            });
            try {
              await within(arrival.settled(), interactionTimeoutMs, `Ingest commit timed out after ${interactionTimeoutMs} ms`);
              if (arrival.failure) throw new Error(arrival.failure);
              const commit = await arrival.requireCommit();
              await arrival.finish();
              return commit.committedAt;
            } finally {
              await arrival.dispose();
            }
          },
        };
      }
      case "compose-open": {
        const editor = composeEditor;
        return {
          startPath: this.base,
          act: async (page, profile) => {
            const link = await this.reveal(page, profile, `a[href="/app/mail/compose?mailbox=${this.setup.mailbox.shortId}&autostart=1"]`);
            await this.arm(page, {
              id,
              action: "pointerdown",
              conditions: [{ selector: editor, visible: true, writable: true, mounted: true }],
            });
            await this.press(profile, link);
            return null;
          },
        };
      }
    }
  }

  private async arm(page: Page, watch: Watch) {
    const armed = await page.evaluate((value) => window.__mailPerfArm?.(value) ?? null, watch);
    if (armed === null) throw new Error("Interaction probe missing in the page");
    if (!armed) throw new Error(`${watch.id}: the end state already holds before the action`);
  }

  /** Waits for the painted end state; tolerates navigations between documents. */
  private async outcome(page: Page): Promise<WatchState> {
    const deadline = performance.now() + interactionTimeoutMs;
    for (;;) {
      this.setup.signal.throwIfAborted();
      const timeout = Math.max(1, deadline - performance.now());
      try {
        const handle = await page.waitForFunction(
          (key) => {
            const value = sessionStorage.getItem(key);
            return value !== null && (JSON.parse(value) as WatchState).hitAt !== null ? value : false;
          },
          watchKey,
          { timeout, polling: 100 },
        );
        return JSON.parse(String(await handle.jsonValue())) as WatchState;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (performance.now() >= deadline || !/context was destroyed|navigat|Target closed/i.test(message))
          throw new Error(`End state not reached within ${interactionTimeoutMs} ms: ${message.split("\n")[0]}`);
      }
    }
  }

  async interaction(
    browser: Browser,
    engine: Engine,
    profile: Profile,
    id: InteractionId,
    traced = false,
  ): Promise<{ sample: InteractionSample; trace: InteractionTrace | null }> {
    let tracing = false;
    let trace: InteractionTrace | null = null;
    let resolveReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const prepared = await this.prepare(id, { ready });
    const url = new URL(prepared.startPath, this.setup.api.origin).href;
    try {
      const { after } = await this.browsers.sample(browser, engine, profile, url, this.setup.api.cookie, {
        timeoutMs: sampleTimeoutMs,
        beforeLoad: async (page) => {
          await page.addInitScript(installInteractionProbe, { key: watchKey, trace: traced });
          page.on("websocket", (socket) =>
            socket.on("framereceived", (frame) => {
              if (typeof frame.payload === "string" && /"t"\s*:\s*"ready"/.test(frame.payload)) resolveReady();
            }),
          );
        },
        afterLoad: async (page, _timing, cdp) => {
          // The person just loaded the start page: like WebKit's fresh context, the interaction
          // reuses what that load cached instead of the cold load's disabled Chromium cache.
          await cdp?.send("Network.setCacheDisabled", { cacheDisabled: false });
          const recorded: Recorded[] = [];
          const settled = new Map<Request, (failure: string | null) => void>();
          const outcomes = new Map<Request, Promise<string | null>>();
          page.on("request", (request) => {
            recorded.push({ request, at: monotonicMs() });
            outcomes.set(request, new Promise((resolve) => settled.set(request, resolve)));
          });
          page.on("requestfinished", (request) => settled.get(request)?.(null));
          // Navigation cancels requests of the previous document; they count with their failure and no bytes.
          page.on("requestfailed", (request) => settled.get(request)?.(request.failure()?.errorText ?? "failed"));
          let markTimeMs = 0;
          let frameIds: string[] = [];
          if (traced) {
            if (!cdp) throw new Error("Interaction tracing requires Chromium");
            const tree = z
              .object({ frameTree: z.object({ frame: z.object({ id: z.string() }) }) })
              .parse(await cdp.send("Page.getFrameTree"));
            frameIds = [tree.frameTree.frame.id];
            await browser.startTracing(page, { categories: traceCategories });
            tracing = true;
            markTimeMs = await page.evaluate((name) => performance.timeOrigin + performance.mark(name).startTime, syncMark);
          }
          const external = await prepared.act(page, profile);
          const state = await this.outcome(page);
          const actionAt = external ?? state.actionAt;
          if (actionAt === null || state.hitAt === null) throw new Error(`${id}: the action was not observed in the page`);
          if (id === "search-submit") {
            const gap = state.inputAt === null ? "unknown" : (actionAt - state.inputAt).toFixed(0);
            if (state.inputAt === null || actionAt - state.inputAt >= searchDebounceMs)
              throw new Error(`search-submit: Enter came ${gap} ms after the typed input; the debounced search may have started first`);
          }
          if (state.hitAt < actionAt && external === null) throw new Error(`${id}: end state painted before the action`);
          const hitAt = state.hitAt;
          if (traced) {
            const buffer = await browser.stopTracing();
            tracing = false;
            trace = interactionTraceBreakdown(JSON.parse(buffer.toString("utf8")), {
              markTimeMs,
              actionAt,
              hitAt,
              mountWindows: state.mountWindows,
              frameIds,
            });
          }
          if (id === "compose-open") {
            // Not timed: prove that the editor really takes input.
            const editor = page.locator(composeEditor).filter({ visible: true }).first();
            await editor.pressSequentially("x", { timeout: interactionTimeoutMs });
            if (!(await editor.inputValue()).includes("x")) throw new Error("compose-open: the editor did not accept input");
          }
          const errors = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "[]") as string[], errorsKey);
          if (errors.length) throw new Error(`${id}: ${errors.join("; ")}`);
          // Candidates by host event time, then the browser's own start time decides: only requests
          // started between the action and the painted end state belong to the timed window.
          const candidates = recorded.filter((entry) => entry.at >= actionAt - clockSlackMs && entry.at <= hitAt + clockSlackMs);
          const settledRequests = await Promise.all(
            candidates.map(async ({ request, at }) => {
              // A request of a replaced document may never settle; it counts as unsettled without bytes.
              const failed = await within(outcomes.get(request)!, unsettledMs, "").catch(
                () => `unsettled ${unsettledMs} ms after the end state`,
              );
              const startTime = request.timing().startTime;
              return { request, failed, startedAt: startTime > 0 ? startTime : at };
            }),
          );
          const requests = await Promise.all(
            settledRequests
              .filter(({ startedAt }) => startedAt >= actionAt && startedAt <= hitAt)
              .map(async ({ request, failed }) => {
                const target = new URL(request.url());
                const sizes = failed === null ? await request.sizes() : null;
                const response = failed === null ? await request.response() : null;
                const timing = request.timing();
                return {
                  ...(failed === null ? interactionRequestTiming(timing) : {}),
                  ...interactionRequestSizes(sizes),
                  method: request.method(),
                  path: `${target.pathname}${target.search}`.slice(0, 300),
                  type: request.resourceType(),
                  status: response?.status() ?? null,
                  encoding: response ? (response.headers()["content-encoding"] ?? "identity") : null,
                  failure: failed,
                };
              }),
          );
          // A live arrival can paint before the worker's commit acknowledgement reaches the host.
          const target =
            id === "mailbox-switch" ? `/app/mail/${this.setup.mailboxB.shortId}` : id === "folder-switch" ? this.base : undefined;
          const sample = interactionSample(Math.max(0, hitAt - actionAt), requests, target);
          if (trace && sample.mainRequest) trace.mainRequest = sample.mainRequest;
          if (target && !sample.mainRequest) throw new Error(`${id}: no destination document or workspace request recorded`);
          return sample;
        },
      });
      if (!after) throw new Error(`${id}: no interaction result`);
      return { sample: after, trace };
    } finally {
      if (tracing) await browser.stopTracing().catch(() => {});
    }
  }

  async load(browser: Browser, engine: Engine, profile: Profile, page: LoadPage): Promise<{ sample: LoadSample; encoding: string }> {
    const target = await this.target(page);
    const url = new URL(target.path, this.setup.api.origin).href;
    let encoding: string | null = null;
    const { metrics, after } = await this.browsers.sample(browser, engine, profile, url, this.setup.api.cookie, {
      beforeLoad: async (tab) => {
        await MailBrowser.prepareLoad(tab, target);
        tab.on("response", (response) => {
          if (encoding === null && response.request().isNavigationRequest() && response.frame() === tab.mainFrame())
            encoding = response.headers()["content-encoding"] ?? "identity";
        });
      },
      afterLoad: async (tab, timing) => {
        await MailBrowser.requireReady(tab, target);
        const documentTransferMs = await tab.evaluate(() => {
          const nav = performance.getEntriesByType("navigation")[0];
          if (!(nav instanceof PerformanceNavigationTiming)) throw new Error("Missing navigation timing");
          return nav.responseEnd - nav.responseStart;
        });
        return { ...timing, documentTransferMs };
      },
    });
    if (!after) throw new Error("Missing load timing");
    if (encoding === null) throw new Error("Missing document response encoding");
    const tasks = after.longtasks.filter((task) => task.start < after.tti);
    return {
      sample: {
        ...metrics,
        documentTransferMs: Number(after.documentTransferMs.toFixed(1)),
        islandMountEndMs: Math.round(Math.max(0, ...after.mountTimes)),
        islandRenderMs: Number(islandRenderMs(after).toFixed(1)),
        longTaskCount: engine === "chromium" ? tasks.length : null,
        longTaskMs: engine === "chromium" ? Math.round(tasks.reduce((sum, task) => sum + task.duration, 0)) : null,
      },
      encoding,
    };
  }

  /** One extra Chromium load with tracing; its timings are not samples because tracing slows the page. */
  async trace(browser: Browser, profile: Profile, page: LoadPage) {
    const target = await this.target(page);
    const url = new URL(target.path, this.setup.api.origin).href;
    let tracing = false;
    try {
      const { after } = await this.browsers.sample(browser, "chromium", profile, url, this.setup.api.cookie, {
        timeoutMs: sampleTimeoutMs,
        beforeLoad: async (tab) => {
          await MailBrowser.prepareLoad(tab, target);
          await browser.startTracing(tab, { categories: traceCategories });
          tracing = true;
        },
        afterLoad: async (tab, timing: LoadTiming) => {
          const markTimeMs = await tab.evaluate((name) => performance.mark(name).startTime, syncMark);
          const buffer = await browser.stopTracing();
          tracing = false;
          await MailBrowser.requireReady(tab, target);
          return traceBreakdown(JSON.parse(buffer.toString("utf8")), { markTimeMs, ...timing });
        },
      });
      if (!after) throw new Error("Missing trace");
      return after;
    } finally {
      if (tracing) await browser.stopTracing().catch(() => {});
    }
  }

  async static(page: LoadPage) {
    const { path } = await this.target(page);
    const url = new URL(path, this.setup.api.origin).href;
    const response = await fetch(url, {
      ...localTls(url, this.setup.api.origin),
      headers: {
        cookie: `session_token=${this.setup.api.cookie}; ${TIMEZONE_COOKIE}=${encodeURIComponent(measuredTimeZone)}`,
        "accept-language": measuredLocale,
      },
      redirect: "manual",
      signal: AbortSignal.any([this.setup.signal, AbortSignal.timeout(30_000)]),
    });
    const html = await response.text();
    validatePage(response.status, url, response.url, html);
    return {
      path: page === "mailbox" ? path : `${this.base}/compose/local/<seed>`,
      static: await measureStatic(html, url, buildRoot, ["core", "mail", "gateway"]),
    };
  }
}

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Measures page loads and interactions for every requested engine and profile into `section`. */
export async function measureBrowsers(setup: Setup, section: BrowserSection, save: () => Promise<void>) {
  const playwright = z
    .object({ version: z.string() })
    .parse(JSON.parse(await readFile(join(repository, "packages/ui/node_modules/playwright/package.json"), "utf8")));
  const catalog = z
    .object({ workspaces: z.object({ catalog: z.object({ playwright: z.string() }) }) })
    .parse(JSON.parse(await readFile(join(repository, "package.json"), "utf8"))).workspaces.catalog;
  if (playwright.version !== catalog.playwright)
    throw new Error("Installed Playwright differs from the root catalog; run bun install --frozen-lockfile");
  section.playwrightVersion = playwright.version;
  const browsers = new Browsers(setup.signal);
  try {
    await browsers.launch(await setup.runtime.startBrowsers(catalog.playwright), section.engines);
    section.versions = browsers.versions();
    const mail = new MailBrowser(setup, browsers);
    const each = async <T extends { status: "ok" | "failed" | "skipped"; reason: string | null }>(
      engine: Engine,
      profile: Profile,
      result: T,
      sample: (browser: Browser) => Promise<void>,
    ) => {
      const browser = browsers.engines.get(engine);
      if (!browser) {
        result.status = "skipped";
        result.reason = browsers.webkitSkip ?? `${engine} not connected`;
        return;
      }
      const failures: string[] = [];
      for (let run = 0; run < section.runs; run++) {
        setup.signal.throwIfAborted();
        try {
          await sample(browser);
        } catch (error) {
          setup.signal.throwIfAborted();
          failures.push(`Run ${run + 1}: ${failure(error)}`);
        }
      }
      if (failures.length) {
        result.status = "failed";
        result.reason = failures.join("; ");
      }
    };
    for (const id of setup.loads) {
      const page: BrowserSection["pages"][number] = { id, path: "", errors: [], static: null, profiles: [] };
      section.pages.push(page);
      try {
        Object.assign(page, await mail.static(id));
      } catch (error) {
        setup.signal.throwIfAborted();
        page.errors.push(`Static: ${failure(error)}`);
      }
      for (const engine of section.engines)
        for (const profile of profiles) {
          console.log(`  load ${id} ${engine} ${profile}`);
          const result: LoadProfile = {
            browser: engine,
            profile,
            status: "ok",
            reason: null,
            documentEncoding: [],
            samples: [],
            metrics: null,
            trace: null,
            traceError: null,
          };
          page.profiles.push(result);
          await each(engine, profile, result, async (browser) => {
            const { sample, encoding } = await mail.load(browser, engine, profile, id);
            result.samples.push(sample);
            result.documentEncoding = [...new Set([...result.documentEncoding, encoding])].sort();
          });
          if (result.status === "ok") result.metrics = summarizeLoads(result.samples);
          const chromium = browsers.engines.get("chromium");
          if (engine === "chromium" && chromium && result.status !== "skipped")
            try {
              result.trace = await mail.trace(chromium, profile, id);
            } catch (error) {
              setup.signal.throwIfAborted();
              result.traceError = failure(error);
            }
          await save();
        }
    }
    for (const definition of interactions.filter((definition) => setup.interactions.includes(definition.id))) {
      const { id } = definition;
      const entry = { id, profiles: [] as InteractionProfile[] };
      section.interactions.push(entry);
      for (const engine of section.engines)
        for (const profile of profiles) {
          console.log(`  interaction ${id} ${engine} ${profile}`);
          const result: InteractionProfile = { browser: engine, profile, status: "ok", reason: null, samples: [], metrics: null };
          entry.profiles.push(result);
          await each(engine, profile, result, async (browser) => {
            result.samples.push((await mail.interaction(browser, engine, profile, id)).sample);
          });
          if (result.status === "ok") result.metrics = summarizeInteraction(result.samples);
          const chromium = browsers.engines.get("chromium");
          if ("trace" in definition && definition.trace && engine === "chromium" && chromium && result.status !== "skipped") {
            try {
              result.trace = (await mail.interaction(chromium, engine, profile, id, true)).trace;
            } catch (error) {
              setup.signal.throwIfAborted();
              result.traceError = failure(error);
            }
          }
          await save();
        }
    }
  } finally {
    try {
      await browsers.close();
    } catch (error) {
      section.errors.push(`Browser cleanup: ${failure(error)}`);
    }
  }
}
