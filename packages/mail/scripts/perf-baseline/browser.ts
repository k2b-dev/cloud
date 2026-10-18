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
import { buildMailSearchHref } from "../../src/frontend/_components/mail-navigation";
import type { LargeMailboxPlan } from "../../test/fixtures/large-mailbox";
import { Arrival } from "./arrival";
import {
  type BrowserSection,
  type Engine,
  type InteractionId,
  type InteractionProfile,
  type InteractionSample,
  interactionSample,
  interactions,
  islandRenderMs,
  type LoadPage,
  type LoadProfile,
  type LoadSample,
  loadPages,
  summarizeInteraction,
  summarizeLoads,
  syncMark,
  traceBreakdown,
} from "./browser-model";
import { monotonicMs } from "./measure";
import { draftSeedBodies } from "./requests";

type Profile = (typeof profiles)[number];
type Condition = { selector: string; text?: string; visible?: boolean; writable?: boolean; mounted?: boolean };
/** pointerdown/input: the trusted input event; mark: the page calls __mailPerfMark; external: the host supplies t0. */
type Watch = { id: string; conditions: Condition[]; action: "pointerdown" | "input" | "mark" | "external" };
type WatchState = Watch & { actionAt: number | null; hitAt: number | null };
declare global {
  interface Window {
    __mailPerfArm?: (watch: Watch) => boolean;
    __mailPerfMark?: () => void;
  }
}

export const watchKey = "cloud-mail-perf-watch";
const interactionTimeoutMs = 30_000;
const sampleTimeoutMs = 120_000;
const unsettledMs = 10_000;
const traceCategories = ["devtools.timeline", "disabled-by-default-devtools.timeline", "v8", "blink.user_timing", "toplevel"];

/**
 * Runs in every document of an interaction page. The armed watch lives in sessionStorage so
 * it survives full navigations (compose). Each animation frame checks the end state; the
 * time is taken in the frame callback that paints it. Times are epoch ms, comparable with
 * the host clock because the browser container shares the host kernel clock.
 */
export function installInteractionProbe(key: string) {
  const now = () => performance.timeOrigin + performance.now();
  const read = (): WatchState | null => {
    const value = sessionStorage.getItem(key);
    return value ? (JSON.parse(value) as WatchState) : null;
  };
  const write = (state: WatchState) => sessionStorage.setItem(key, JSON.stringify(state));
  const holds = (condition: Condition) => {
    for (const element of document.querySelectorAll(condition.selector)) {
      if (condition.text !== undefined && !(element.textContent ?? "").includes(condition.text)) continue;
      if (condition.writable) {
        const writable =
          element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
            ? !element.disabled && !element.readOnly
            : element instanceof HTMLElement && element.isContentEditable;
        if (!writable) continue;
      }
      if (condition.mounted) {
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
      if (matches(state)) {
        state.hitAt = now();
        write(state);
      } else requestAnimationFrame(tick);
    });
  for (const type of ["pointerdown", "input"] as const)
    addEventListener(
      type,
      (event) => {
        if (!event.isTrusted) return;
        const state = read();
        if (!state || state.action !== type || state.actionAt !== null || state.hitAt !== null) return;
        state.actionAt = performance.timeOrigin + event.timeStamp;
        write(state);
      },
      { capture: true },
    );
  window.__mailPerfArm = (watch) => {
    // An end state that already holds cannot be caused by the coming action.
    if (matches(watch)) return false;
    write({ ...watch, actionAt: null, hitAt: null });
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
  nextUid: () => number;
};
type Recorded = { request: Request; at: number };
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
  private async route(href: string) {
    return listSchema.parse(
      await this.setup.api.request(`/api/mail/mailboxes/${this.setup.mailbox.shortId}/workspace-route?href=${encodeURIComponent(href)}`),
    );
  }
  private async first(href: string) {
    const item = (await this.route(href)).listItems[0];
    if (!item) throw new Error(`Fixture list is empty: ${href}`);
    return item;
  }
  async composePath() {
    const body = draftSeedBodies(this.setup.fixture.senderIdentityId, this.setup.plan.messages[0]!)[0]!;
    const seed = z
      .object({ id: z.string().min(1) })
      .parse(await this.setup.api.request(`/api/mail/mailboxes/${this.setup.mailbox.shortId}/draft-seeds`, "POST", body));
    return `${this.base}/compose/local/${seed.id}?return=${encodeURIComponent(this.base)}`;
  }
  pagePath(page: LoadPage) {
    return page === "mailbox" ? Promise.resolve(this.base) : this.composePath();
  }

  /** A link that is visible now; on phones the navigation sits behind the app menu. */
  private async reveal(page: Page, profile: Profile, selector: string): Promise<Locator> {
    const link = page.locator(selector).filter({ visible: true }).first();
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
        const row = await this.first(this.inbox);
        if (!row.conversationId) throw new Error("Inbox starts with a message row; expected conversations");
        const detail = z
          .object({ detailMessages: z.array(z.object({ id: z.string() })) })
          .parse(await this.setup.api.request(`/api/mail/mailboxes/${this.setup.mailbox.shortId}/workspace-detail/${row.conversationId}`));
        const newest = detail.detailMessages.at(-1);
        if (!newest) throw new Error(`Conversation ${row.conversationId} has no messages`);
        return {
          startPath: this.inbox,
          act: async (page, profile) => {
            const link = page
              .locator(`${rowSelector(row)} a`)
              .filter({ visible: true })
              .first();
            await link.waitFor({ timeout: interactionTimeoutMs });
            await this.arm(page, {
              id,
              action: "pointerdown",
              conditions: [{ selector: `[data-mail-message-id="${newest.id}"]`, visible: true }],
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
              action: "input",
              conditions: [
                { selector: "[data-mail-list-heading]", text: shape.rareWord },
                { selector: rowSelector(row), visible: true },
              ],
            });
            await input.fill(shape.rareWord, { timeout: interactionTimeoutMs });
            await input.press("Enter", { timeout: interactionTimeoutMs });
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
        const editor = 'textarea[aria-label="Message body"]';
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

  /** Host epoch time of the latest arm; requests from here on belong to the interaction. */
  private armedAt = 0;
  private async arm(page: Page, watch: Watch) {
    this.armedAt = monotonicMs();
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

  async interaction(browser: Browser, engine: Engine, profile: Profile, id: InteractionId): Promise<InteractionSample> {
    let resolveReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const prepared = await this.prepare(id, { ready });
    const url = new URL(prepared.startPath, this.setup.api.origin).href;
    const { after } = await this.browsers.sample(browser, engine, profile, url, this.setup.api.cookie, {
      timeoutMs: sampleTimeoutMs,
      beforeLoad: async (page) => {
        await page.addInitScript(installInteractionProbe, watchKey);
        page.on("websocket", (socket) =>
          socket.on("framereceived", (frame) => {
            if (typeof frame.payload === "string" && /"t"\s*:\s*"ready"/.test(frame.payload)) resolveReady();
          }),
        );
      },
      afterLoad: async (page) => {
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
        const external = await prepared.act(page, profile);
        const state = await this.outcome(page);
        const observedAt = monotonicMs();
        const actionAt = external ?? state.actionAt;
        if (actionAt === null || state.hitAt === null) throw new Error(`${id}: the action was not observed in the page`);
        if (state.hitAt < actionAt && external === null) throw new Error(`${id}: end state painted before the action`);
        const caused = recorded.filter((entry) => entry.at >= this.armedAt && entry.at <= observedAt);
        if (id === "compose-open") {
          // Not timed: prove that the editor really takes input.
          const editor = page.locator('textarea[aria-label="Message body"]').filter({ visible: true }).first();
          await editor.pressSequentially("x", { timeout: interactionTimeoutMs });
          if (!(await editor.inputValue()).includes("x")) throw new Error("compose-open: the editor did not accept input");
        }
        const requests = await Promise.all(
          caused.map(async ({ request }) => {
            const target = new URL(request.url());
            // A request of a replaced document may never settle; it counts as unsettled without bytes.
            const failed = await within(outcomes.get(request)!, unsettledMs, "").catch(
              () => `unsettled ${unsettledMs} ms after the end state`,
            );
            const sizes = failed === null ? await request.sizes() : null;
            return {
              method: request.method(),
              path: `${target.pathname}${target.search}`.slice(0, 300),
              type: request.resourceType(),
              status: failed === null ? ((await request.response())?.status() ?? null) : null,
              bytes: sizes ? sizes.responseBodySize + sizes.responseHeadersSize : 0,
              failure: failed,
            };
          }),
        );
        // A live arrival can paint before the worker's commit acknowledgement reaches the host.
        return interactionSample(Math.max(0, state.hitAt - actionAt), requests);
      },
    });
    if (!after) throw new Error(`${id}: no interaction result`);
    return after;
  }

  async load(browser: Browser, engine: Engine, profile: Profile, page: LoadPage): Promise<LoadSample> {
    const url = new URL(await this.pagePath(page), this.setup.api.origin).href;
    const { metrics, after } = await this.browsers.sample(browser, engine, profile, url, this.setup.api.cookie, {
      afterLoad: async (_page, timing) => timing,
    });
    if (!after) throw new Error("Missing load timing");
    const tasks = after.longtasks.filter((task) => task.start < after.tti);
    return {
      ...metrics,
      islandMountEndMs: Math.round(Math.max(0, ...after.mountTimes)),
      islandRenderMs: Number(islandRenderMs(after).toFixed(1)),
      longTaskCount: engine === "chromium" ? tasks.length : null,
      longTaskMs: engine === "chromium" ? Math.round(tasks.reduce((sum, task) => sum + task.duration, 0)) : null,
    };
  }

  /** One extra Chromium load with tracing; its timings are not samples because tracing slows the page. */
  async trace(browser: Browser, profile: Profile, page: LoadPage) {
    const url = new URL(await this.pagePath(page), this.setup.api.origin).href;
    let tracing = false;
    try {
      const { after } = await this.browsers.sample(browser, "chromium", profile, url, this.setup.api.cookie, {
        timeoutMs: sampleTimeoutMs,
        beforeLoad: async (tab) => {
          await browser.startTracing(tab, { categories: traceCategories });
          tracing = true;
        },
        afterLoad: async (tab, timing: LoadTiming) => {
          const markTimeMs = await tab.evaluate((name) => performance.mark(name).startTime, syncMark);
          const buffer = await browser.stopTracing();
          tracing = false;
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
    const path = await this.pagePath(page);
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
    for (const id of loadPages) {
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
            samples: [],
            metrics: null,
            trace: null,
            traceError: null,
          };
          page.profiles.push(result);
          await each(engine, profile, result, async (browser) => {
            result.samples.push(await mail.load(browser, engine, profile, id));
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
    for (const { id } of interactions) {
      const entry = { id, profiles: [] as InteractionProfile[] };
      section.interactions.push(entry);
      for (const engine of section.engines)
        for (const profile of profiles) {
          console.log(`  interaction ${id} ${engine} ${profile}`);
          const result: InteractionProfile = { browser: engine, profile, status: "ok", reason: null, samples: [], metrics: null };
          entry.profiles.push(result);
          await each(engine, profile, result, async (browser) => {
            result.samples.push(await mail.interaction(browser, engine, profile, id));
          });
          if (result.status === "ok") result.metrics = summarizeInteraction(result.samples);
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
