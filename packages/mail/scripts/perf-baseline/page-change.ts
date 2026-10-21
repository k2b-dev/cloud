import type { Browser, CDPSession, Page } from "playwright";
import { z } from "zod";
import type { Browsers, Engine, Profile } from "../../../../scripts/perf-baseline/browser";
import { validatePage } from "../../../../scripts/perf-baseline/model";
import { panelEndState } from "../../../../scripts/perf-baseline/panel-probe";
import {
  type PageChangeId,
  type PageChanges,
  pageChangeIds,
  pageChangeSampleSchema,
  requireWarmCache,
  sequenceSnapshotSchema,
} from "./page-change-model";
import { recordPageChangeNetwork } from "./page-change-network";
import { installPageChangeProbe, installResourceProbe, pageChangeKey } from "./page-change-probe";

const timeout = 45_000;
type Setup = { signal: AbortSignal; origin: string; cookie: string; mailboxId: string };
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class PageChangesBrowser {
  constructor(
    private readonly setup: Setup,
    private readonly browsers: Browsers,
  ) {}
  private get mailbox() {
    return `/app/mail/${this.setup.mailboxId}`;
  }
  private get automations() {
    return `${this.mailbox}/automations`;
  }
  private start(id: PageChangeId) {
    return id === "overview-mailbox" ? "/app/mail" : id === "mailbox-automations" ? this.mailbox : this.automations;
  }
  private target(id: PageChangeId) {
    return id === "mailbox-automations" ? this.automations : this.mailbox;
  }

  private async ready(page: Page) {
    await page.waitForFunction(
      () => {
        const islands = [...document.querySelectorAll("solid-island,solid-client")];
        return islands.length > 0 && islands.every((el) => window.__cloudPerf.mounted.has(el));
      },
      undefined,
      { timeout, polling: "raf" },
    );
  }
  private async goto(page: Page, path: string) {
    const url = new URL(path, this.setup.origin).href;
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    if (!response) throw new Error(`Missing document: ${path}`);
    validatePage(response.status(), url, page.url(), await response.text());
    await this.ready(page);
  }
  private async panelReady(page: Page, mailbox: boolean) {
    await page.waitForFunction((mailbox) => window.__mailPageChange.panelReady(mailbox), mailbox, { timeout, polling: "raf" });
  }
  private async warm(page: Page, id: PageChangeId, cdp: CDPSession | undefined, profile: Profile) {
    await cdp?.send("Network.setCacheDisabled", { cacheDisabled: false });
    // Each real destination document primes its eager graph; start-page assets alone do not.
    for (const path of [this.mailbox, this.automations, this.start(id)]) await this.goto(page, path);
    if (profile === "desktop") await this.panelReady(page, this.start(id) === this.mailbox);
  }
  private async click(page: Page, profile: Profile, id: PageChangeId) {
    const press = async (locator: ReturnType<Page["locator"]>) => {
      if (profile === "phone") await locator.tap({ timeout });
      else await locator.click({ timeout });
    };
    if (id === "mailbox-automations") {
      // Open before arming: only selecting the actual rendered menu entry is timed.
      await press(
        page
          .getByRole("button", { name: /^Options for / })
          .filter({ visible: true })
          .first(),
      );
      const item = page
        .getByRole("menuitem", { name: "Automations", exact: true })
        .or(page.getByRole("button", { name: "Automations", exact: true }))
        .filter({ visible: true })
        .first();
      await item.waitFor({ state: "visible", timeout });
      return { locator: item, press };
    }
    const link = page.locator(`a[href="${this.mailbox}"]`).filter({ visible: true }).first();
    if ((await link.count()) === 0 && profile === "phone")
      await page.getByRole("button", { name: "Open apps", exact: true }).tap({ timeout });
    await link.waitFor({ state: "visible", timeout });
    return { locator: link, press };
  }

  private async change(
    page: Page,
    profile: Profile,
    id: PageChangeId,
    cache: "cold" | "warm",
    cdp: CDPSession | undefined,
    verifyAction = true,
  ) {
    this.setup.signal.throwIfAborted();
    const target = this.target(id);
    const automated = id === "mailbox-automations";
    // The open Help column can hide Automations' sidebar settings even at desktop width.
    const control = automated ? 'button[aria-label="Open apps"]' : "[data-mail-conversation-list] button:has(i.ti-checkbox)";
    const action = await this.click(page, profile, id);
    const before = await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('#cloud-panel iframe[data-cloud-panel-frame="core"]');
      return { origin: performance.timeOrigin, panelOrigin: frame?.contentWindow?.performance.timeOrigin ?? null };
    });
    const oldFrame =
      profile === "desktop" ? await page.locator('#cloud-panel iframe[data-cloud-panel-frame="core"]').elementHandle() : null;
    const errors: string[] = [];
    const onError = (error: Error) => errors.push(error.message);
    const network = recordPageChangeNetwork(page, target, cdp);
    page.on("pageerror", onError);
    try {
      await page.evaluate(
        ({ key, watch }) => {
          performance.clearResourceTimings();
          sessionStorage.removeItem(key);
          window.__mailPageChange.arm(watch);
        },
        {
          key: pageChangeKey,
          watch: {
            targetPath: target,
            mainSelector: automated ? "h1" : "[data-mail-conversation-list] [data-conversation-id]",
            mainText: automated ? "Automations" : null,
            actionSelector: control,
            responseSelector: automated ? "dialog[open]" : '[data-mail-conversation-list] [role="toolbar"]',
            expectedHelpTopic: automated ? null : "mail-work",
          },
        },
      );
      await action.press(action.locator);
      // waitForFunction survives navigations. It uses frame polling, not a host sleep.
      await page.waitForFunction(
        () => window.__mailPageChange?.read()?.readyAt !== null && window.__mailPageChange?.read()?.readyAt !== undefined,
        undefined,
        { timeout, polling: "raf" },
      );
      if (verifyAction) {
        const first = page.locator(control).filter({ visible: true }).first();
        if (profile === "phone") await first.tap({ timeout });
        else await first.click({ timeout });
      }
      await page.waitForFunction(
        ({ profile, verifyAction }) => {
          const watch = window.__mailPageChange?.read();
          return (
            watch &&
            watch.mainAt !== null &&
            (!verifyAction || watch.firstActionAt !== null) &&
            (profile === "phone" || watch.panelAt !== null)
          );
        },
        { profile, verifyAction },
        { timeout, polling: "raf" },
      );
      const sizes = await network.finish();
      // ResourceTiming entries arrive on completion. A full document must expose its independent eager graph.
      if (await page.evaluate((origin) => performance.timeOrigin !== origin, before.origin))
        await page.waitForFunction(
          () => {
            if (window.__mailPageChange.read()?.actionAt === null) return false;
            const eager = window.__mailPageChange.eagerScripts();
            return eager.every((url) => performance.getEntriesByName(url, "resource").length > 0);
          },
          undefined,
          { timeout: 10_000, polling: "raf" },
        );
      const state = await page.evaluate(() => ({
        watch: window.__mailPageChange.read(),
        errors: [...window.__cloudPerf.errors, ...window.__mailPageChange.errors()],
        origin: performance.timeOrigin,
        panelOrigin:
          document.querySelector<HTMLIFrameElement>('#cloud-panel iframe[data-cloud-panel-frame="core"]')?.contentWindow?.performance
            .timeOrigin ?? null,
        eager: window.__mailPageChange.eagerScripts(),
        resources: performance.getEntriesByType("resource").map((entry) => {
          const resource = entry as PerformanceResourceTiming;
          return {
            name: resource.name,
            transferSize: resource.transferSize,
            startTime: resource.startTime,
            initiatorType: resource.initiatorType,
          };
        }),
      }));
      errors.push(...state.errors);
      if (errors.length) throw new Error(`Page change failed: ${errors.join("; ")}`);
      const watch = state.watch;
      if (!watch || watch.actionAt === null || watch.mainAt === null || (verifyAction && watch.firstActionAt === null))
        throw new Error("Missing page-change timestamps");
      const documentLoad = state.origin !== before.origin;
      const scriptResources = state.resources.filter(
        (entry) => /\.m?js(?:\?|$)/.test(entry.name) && state.origin + entry.startTime <= watch.readyAt!,
      );
      if (cache === "warm") {
        // A retained document reuses already evaluated modules without a new ResourceTiming entry.
        if (documentLoad || scriptResources.length)
          requireWarmCache(scriptResources, [
            ...new Set([...(documentLoad ? state.eager : []), ...scriptResources.map((entry) => entry.name)]),
          ]);
      }
      const sameFrame = oldFrame ? await oldFrame.evaluate((frame) => frame.isConnected).catch(() => false) : false;
      return pageChangeSampleSchema.parse({
        clickToMainMs: watch.mainAt - watch.actionAt,
        clickToFirstActionMs: (watch.firstActionAt ?? watch.readyAt)! - watch.actionAt,
        documentLoad,
        panelReloaded:
          profile === "desktop" ? !sameFrame || before.panelOrigin !== state.panelOrigin || network.providerDocuments.length > 0 : null,
        panelContextMs: profile === "desktop" && watch.panelAt !== null ? watch.panelAt - watch.actionAt : null,
        panelStatus: profile === "desktop" ? "observed" : "unavailable-phone",
        ...sizes,
        eagerJsTransferBytes: scriptResources.reduce((sum, entry) => sum + entry.transferSize, 0),
      });
    } finally {
      page.off("pageerror", onError);
      network.stop();
      await oldFrame?.dispose();
      await page
        .evaluate((key) => {
          window.__mailPageChange?.stop();
          sessionStorage.removeItem(key);
          sessionStorage.removeItem(`${key}:errors`);
        }, pageChangeKey)
        .catch(() => {});
    }
  }

  async sample(
    browser: Browser,
    engine: Engine,
    profile: Profile,
    id: PageChangeId,
    cache: "cold" | "warm",
    sequence?: PageChanges["sequence"],
  ) {
    const { after } = await this.browsers.sample(
      browser,
      engine,
      profile,
      new URL(this.start(id), this.setup.origin).href,
      this.setup.cookie,
      {
        timeoutMs: sequence ? 900_000 : 180_000,
        beforeLoad: async (page) => {
          if (sequence) await page.addInitScript(installResourceProbe);
          await page.addInitScript({
            content: `(${installPageChangeProbe.toString()})({key:${JSON.stringify(pageChangeKey)},panel:${panelEndState.toString()}})`,
          });
          if (profile === "desktop")
            await page
              .context()
              .addCookies([{ name: "cloud_panel", value: "1:core:", url: this.setup.origin, secure: true, sameSite: "Lax" }]);
        },
        afterLoad: async (page, _timing, cdp) => {
          if (cache === "warm") await this.warm(page, id, cdp, profile);
          else if (profile === "desktop") await this.panelReady(page, this.start(id) === this.mailbox);
          if (!sequence) return this.change(page, profile, id, cache, cdp);
          if (!cdp) throw new Error("Sequence requires Chromium CDP");
          const snapshot = async (changes: number) => {
            // The load observer must not retain replaced islands or accumulate its own history.
            await page.evaluate(() => {
              const probe = window.__cloudPerf;
              probe.flush();
              probe.initial = probe.initial?.filter((el) => el.isConnected) ?? null;
              for (const map of [probe.started, probe.mounted])
                for (const element of map.keys()) if (!element.isConnected) map.delete(element);
              probe.resources.length = probe.longtasks.length = 0;
              if (probe.shifts) probe.shifts.length = 0;
              performance.clearResourceTimings();
            });
            await cdp.send("HeapProfiler.collectGarbage");
            const heap = z.object({ usedSize: z.number() }).parse(await cdp.send("Runtime.getHeapUsage"));
            const dom = z.object({ nodes: z.number(), jsEventListeners: z.number() }).parse(await cdp.send("Memory.getDOMCounters"));
            sequence.snapshots.push(
              sequenceSnapshotSchema.parse({
                changes,
                heapUsedBytes: heap.usedSize,
                domNodes: dom.nodes,
                jsEventListeners: dom.jsEventListeners,
                ...(await page.evaluate(() => window.__mailResources())),
              }),
            );
          };
          await snapshot(0);
          for (let n = 1; n <= 150; n++) {
            const sample = await this.change(page, "desktop", n % 2 ? "mailbox-automations" : "automations-mailbox", "warm", cdp, false);
            if (n <= 20) {
              sequence.first20DocumentLoads += Number(sample.documentLoad);
              sequence.first20PanelReloads += Number(sample.panelReloaded);
            }
            if (n % 50 === 0) await snapshot(n);
          }
          return undefined;
        },
      },
    );
    return after;
  }
}

export async function measurePageChanges(
  setup: Setup,
  browsers: Browsers,
  runs: number,
  engines: Engine[],
  section: PageChanges,
  save: () => Promise<void>,
) {
  const driver = new PageChangesBrowser(setup, browsers);
  for (const id of pageChangeIds)
    for (const engine of engines)
      for (const profile of ["desktop", "phone"] as const)
        for (const cache of ["cold", "warm"] as const) {
          const result: PageChanges["profiles"][number] = {
            id,
            browser: engine,
            profile,
            cache,
            status: "failed",
            reason: "Measurement incomplete",
            samples: [],
          };
          section.profiles.push(result);
          const browser = browsers.engines.get(engine);
          if (!browser) {
            result.status = "skipped";
            result.reason = browsers.webkitSkip ?? "Browser unavailable";
          } else
            for (let run = 0; run < runs; run++) {
              console.log(`  page-change ${id} ${engine}/${profile}/${cache} ${run + 1}/${runs}`);
              try {
                const sample = await driver.sample(browser, engine, profile, id, cache);
                if (!sample) throw new Error("Missing page-change sample");
                result.samples.push(sample);
              } catch (error) {
                setup.signal.throwIfAborted();
                result.status = "failed";
                result.reason = [result.reason, errorText(error)].filter(Boolean).join("; ");
              }
            }
          if (result.samples.length === runs && result.reason === "Measurement incomplete") {
            result.status = "ok";
            result.reason = null;
          }
          await save();
        }
  const chromium = browsers.engines.get("chromium");
  if (!chromium) {
    section.sequence.status = "skipped";
    section.sequence.reason = "Chromium not selected/available";
  } else
    try {
      await driver.sample(chromium, "chromium", "desktop", "mailbox-automations", "warm", section.sequence);
      section.sequence.status = "ok";
      section.sequence.reason = null;
    } catch (error) {
      setup.signal.throwIfAborted();
      section.sequence.status = "failed";
      section.sequence.reason = errorText(error);
    }
  await save();
}
