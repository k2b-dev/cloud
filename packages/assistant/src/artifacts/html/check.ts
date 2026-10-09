import type { Browser, BrowserContext, BrowserType, Page } from "playwright";
import { z } from "zod";
import type { ArtifactSource } from "../contracts";
import {
  CHECK_LIMITS,
  type CheckIssue,
  CheckReport,
  type CheckStart,
  diagnosticSeverity,
  layoutIssues,
  modelCheckReport,
} from "./check-contracts";
import type { CheckState } from "./check-host";
import type { CheckCommand } from "./check-realm";

const Finding = z.object({ severity: z.enum(["error", "warning"]), kind: z.string(), message: z.string(), key: z.string() });
const Point = z.object({ x: z.number(), y: z.number(), checked: z.boolean(), type: z.string() });
const Measure = z.object({
  height: z.number(),
  empty: z.boolean(),
  overflowX: z.boolean(),
  wide: z.array(z.string()),
  clipped: z.array(z.string()),
  invalid: z.array(z.string()),
  interactive: z.boolean(),
  password: z.boolean(),
  untyped: z.boolean(),
  layout: z.array(Finding),
});
const Violations = z.array(
  z.object({ id: z.string(), impact: z.string().nullable(), help: z.string(), count: z.number(), target: z.string() }),
);
export type CheckDriver = {
  browser: {
    browserType(): Pick<BrowserType, "name">;
    newContext(options: Parameters<Browser["newContext"]>[0]): Promise<Pick<BrowserContext, "close" | "newPage">>;
  };
  initialize(page: Page): Promise<void>;
  start(signal: AbortSignal): Promise<CheckStart>;
  discard(scopeId: string): Promise<void>;
  save(name: string, bytes: Uint8Array, type: string, signal: AbortSignal): Promise<string>;
  upload(path: string, source: ArtifactSource, signal: AbortSignal): Promise<{ name: string; data: string; type: string }>;
  conversationId: string;
  signal: AbortSignal;
};
/** Playwright wraps realm errors as "evaluate: Error: …" plus a minified stack; the agent needs the message. */
export const stepError = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .replace(/^(?:[\w.]*evaluate: )?(?:Error: )+/, "")
    .split("\n")
    .filter((line) => !/^\s+at |^\S*@\S+:\d+:\d+$/.test(line))
    .join("\n")
    .trim();
/** Two genuine browser contexts, with separate server-owned disposable data. */
export async function runHtmlCheck(driver: CheckDriver): Promise<CheckReport> {
  const signal = AbortSignal.any([driver.signal, AbortSignal.timeout(CHECK_LIMITS.durationMs)]);
  const issues: CheckIssue[] = [],
    calls = new Map<string, { method: string; count: number; failed: number }>();
  const screenshots: CheckReport["screenshots"] = [],
    downloads: CheckReport["downloads"] = [];
  let hash = "",
    height = 0,
    aria = "",
    outputBytes = 0,
    downloadCount = 0,
    issueBudgetExceeded = false;
  let theme: "light" | "dark" = "light";
  const save = async (name: string, bytes: Uint8Array, type: string) => {
    signal.throwIfAborted();
    if (bytes.byteLength > CHECK_LIMITS.fileBytes || outputBytes + bytes.byteLength > CHECK_LIMITS.outputBytes)
      throw new Error("Check output exceeds the 50 MiB file / 250 MiB total budget");
    outputBytes += bytes.byteLength;
    const path = await driver.save(name, bytes, type, signal);
    signal.throwIfAborted();
    return path;
  };
  for (const view of ["desktop", "mobile"] as const) {
    signal.throwIfAborted();
    const start = await driver.start(signal);
    if (!hash) {
      hash = start.hash;
      theme = start.theme;
    }
    const viewTheme = view === "desktop" ? theme : theme === "dark" ? "light" : "dark";
    const add = (kind: string, message: string, severity: CheckIssue["severity"] = "error", where?: string) => {
      if (issueBudgetExceeded) return;
      if (issues.length >= CHECK_LIMITS.issues) {
        issueBudgetExceeded = true;
        issues[issues.length - 1] = {
          severity: "error",
          kind: "budget",
          message: "Diagnostic budget exceeded; later findings were dropped.",
        };
        return;
      }
      issues.push({ severity, kind, message: message.slice(0, 6000), where, view });
    };
    let context: Awaited<ReturnType<CheckDriver["browser"]["newContext"]>> | undefined;
    // Abort and finally must await the same close: a second Playwright close
    // can resolve while the first one is still removing the context.
    let closing: Promise<void> | undefined;
    const close = () => {
      if (!context) return Promise.resolve();
      closing ??= context.close();
      return closing;
    };
    const cancel = () => {
      void close().catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      if (hash !== start.hash) add("changed", "Files or table definitions changed between the two check runs; check again.");
      for (const warning of start.warnings) add("copy", warning, "warning");
      context = await driver.browser.newContext({
        viewport: view === "desktop" ? { width: 1280, height: 800 } : { width: 390, height: 844 },
        hasTouch: view === "mobile",
        isMobile: view === "mobile" && driver.browser.browserType().name() === "chromium",
        deviceScaleFactor: 1,
        colorScheme: viewTheme,
        locale: start.context.locale,
        timezoneId: start.context.timeZone,
      });
      // An abort during newContext has no context to close until it resolves.
      signal.throwIfAborted();
      const page = await context.newPage();
      signal.throwIfAborted();
      page.setDefaultTimeout(CHECK_LIMITS.readyMs);
      await page.exposeFunction("assistantCheckDownload", async (name: string, data: string, type: string) => {
        signal.throwIfAborted();
        if (downloadCount >= CHECK_LIMITS.downloads) throw new Error("Check download budget exceeded");
        const ordinal = ++downloadCount;
        const bytes = new Uint8Array(Buffer.from(data, "base64"));
        const safe =
          name
            .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
            .replace(/^\.+/, "")
            .slice(0, 180) || "download";
        const path = await save(`${view}-${ordinal}-${safe}`, bytes, type || "application/octet-stream");
        downloads.push({ name, type, size: bytes.byteLength, path, view });
      });
      signal.throwIfAborted();
      await driver.initialize(page);
      signal.throwIfAborted();
      const mount = async () => {
        signal.throwIfAborted();
        await page.evaluate((input) => window.assistantCheckMount(input), {
          source: start.source,
          scopeId: start.scopeId,
          artifactId: start.artifactId,
          context: start.context,
          assets: start.assets,
          conversationId: driver.conversationId,
          theme: viewTheme,
        });
        signal.throwIfAborted();
      };
      const command = async (input: CheckCommand) => {
        signal.throwIfAborted();
        const result = await page.evaluate((input) => window.assistantCheckInspect(input), input);
        signal.throwIfAborted();
        return result;
      };
      const settle = () => command({ op: "settle" });
      const waitReady = async () => {
        signal.throwIfAborted();
        await page.waitForFunction(() => window.assistantCheckState().ready, undefined, { timeout: CHECK_LIMITS.readyMs });
        await settle();
      };
      const collect = (state: CheckState) => {
        for (const issue of state.lint) add(`lint:${issue.kind}`, issue.message, issue.severity, issue.where);
        for (const finding of state.pdf) add(finding.kind, finding.message, finding.severity);
        for (const event of state.events) {
          if (event.type === "error" || (event.type === "log" && event.level === "error"))
            add(
              event.type === "error" ? "uncaught" : event.text.includes("Blocked by the app sandbox") ? "sandbox" : "console",
              event.text,
              diagnosticSeverity(event.text),
              "where" in event ? event.where : undefined,
            );
          else if (event.type === "log" && event.level === "warn") add("console", event.text, "warning");
          else if (event.type === "not-ready") add("ready", "App did not become ready within 10 seconds.");
          else if (event.type === "stopped" && event.reason !== "request") add("sandbox", `App stopped: ${event.reason}.`);
          else if (event.type === "call") {
            const call = calls.get(event.method) ?? { method: event.method, count: 0, failed: 0 };
            call.count++;
            if (!event.ok) call.failed++;
            calls.set(event.method, call);
          }
        }
      };
      // A finding reported once per view: a text shown after one step usually stays for the next ones,
      // and a misaligned row is reported in the final state, from startup only when the steps removed it.
      const reported = new Set<string>();
      const report = (finding: z.infer<typeof Finding>, prefix = "") => {
        if (reported.has(finding.key)) return;
        reported.add(finding.key);
        add(finding.kind, prefix + finding.message, finding.severity);
      };
      // The whole page up to a bounded height: what lies below the first screen is part of the result.
      const shot = async (name: "desktop-start" | "desktop" | "mobile", pageHeight: number) => {
        signal.throwIfAborted();
        const viewport = page.viewportSize()!;
        let height = viewport.height,
          full = pageHeight;
        try {
          // A taller viewport grows layouts sized in viewport units, so measure again, and grow at most once more.
          for (let round = 0; round < 2 && full > height && height < CHECK_LIMITS.screenshotHeight; round++) {
            height = Math.min(full, CHECK_LIMITS.screenshotHeight);
            await page.setViewportSize({ width: viewport.width, height });
            await settle();
            full = z.number().parse(await command({ op: "height" }));
          }
          await page.mouse.move(0, 0);
          signal.throwIfAborted();
          const bytes = await page.screenshot({ type: "png", timeout: CHECK_LIMITS.readyMs });
          screenshots.push({
            view: name,
            theme: viewTheme,
            path: await save(`${name}-${viewTheme}.png`, new Uint8Array(bytes), "image/png"),
            cropped: full > height,
          });
        } finally {
          if (height > viewport.height) await page.setViewportSize(viewport);
        }
      };
      await mount();
      let ready = true;
      try {
        await waitReady();
      } catch {
        signal.throwIfAborted();
        ready = false;
        add("ready", "App did not become ready within 10 seconds.");
      }
      if (ready) {
        // K1 checks startup too: steps must not hide/delete all the controls.
        const before = Measure.parse(await command({ op: "measure" }));
        for (const issue of layoutIssues(view, { ...before, invalid: [] }, start.steps.length))
          add(issue.kind, issue.message, issue.severity, issue.where);
        for (const finding of before.layout) if (finding.kind.startsWith("shown-")) report(finding);
        if (view === "desktop") await shot("desktop-start", before.height);
        for (const [index, step] of start.steps.entries()) {
          signal.throwIfAborted();
          try {
            if (step.action === "reload") {
              collect(await page.evaluate(() => window.assistantCheckState()));
              await mount();
              await waitReady();
            } else if (step.action === "select") await command({ op: "select", target: step.target, value: step.value });
            else if (step.action === "upload")
              await command({ op: "upload", target: step.target, ...(await driver.upload(step.file, start.source, signal)) });
            else if (step.action === "press") {
              if (step.target) await command({ op: "focus", target: step.target });
              signal.throwIfAborted();
              await page.keyboard.press(step.value);
            } else {
              const point = Point.parse(await command({ op: "locate", target: step.target }));
              if (step.action === "fill" && /^(date|time|datetime-local|month|week|color|range)$/.test(point.type))
                await command({ op: "set", target: step.target, value: step.value });
              else {
                const box = await page.locator("iframe.studio-app-frame").boundingBox();
                signal.throwIfAborted();
                if (!box) throw new Error("App frame disappeared");
                if (!((step.action === "check" && point.checked) || (step.action === "uncheck" && !point.checked)))
                  await page.mouse.click(box.x + point.x, box.y + point.y);
                if (step.action === "fill") {
                  signal.throwIfAborted();
                  await page.keyboard.press("ControlOrMeta+A");
                  signal.throwIfAborted();
                  await page.keyboard.press("Delete");
                  signal.throwIfAborted();
                  if (step.value) await page.keyboard.insertText(step.value);
                }
                if (step.action === "check" || step.action === "uncheck") {
                  const after = Point.parse(await command({ op: "locate", target: step.target }));
                  if (after.checked !== (step.action === "check")) throw new Error("Checkbox did not reach the requested state");
                }
              }
            }
            await settle();
            for (const finding of Finding.array().parse(await command({ op: "shown" }))) report(finding, `After step ${index + 1}: `);
          } catch (error) {
            signal.throwIfAborted();
            add("step", `Step ${index + 1} (${step.action}): ${stepError(error)}`);
            break;
          }
        }
        const measure = Measure.parse(await command({ op: "measure" }));
        if (view === "desktop") {
          height = Math.min(measure.height, 100000);
          aria = z.string().parse(await command({ op: "aria" }));
        }
        for (const issue of layoutIssues(view, measure, start.steps.length)) add(issue.kind, issue.message, issue.severity, issue.where);
        if (measure.password) add("password", "App contains a password field; use Cloud secret input for credentials.", "warning");
        if (measure.untyped) add("buttons", "Several buttons in a form have no explicit type.", "warning");
        for (const finding of [...measure.layout, ...before.layout]) report(finding);
        for (const v of Violations.parse(await command({ op: "axe" })))
          add(
            "a11y",
            `${v.id} (${v.impact}, ${v.count}×): ${v.help}`,
            ["critical", "serious"].includes(v.impact ?? "") ? "error" : "warning",
            v.target,
          );
        await shot(view, measure.height);
      }
      collect(await page.evaluate(() => window.assistantCheckState()));
    } catch (error) {
      signal.throwIfAborted();
      add("check", error instanceof Error ? error.message : String(error));
    } finally {
      try {
        await close();
      } finally {
        signal.removeEventListener("abort", cancel);
        await driver.discard(start.scopeId);
      }
    }
  }
  signal.throwIfAborted();
  const unique = [...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).values()];
  return CheckReport.parse(
    modelCheckReport({
      passed: !unique.some((issue) => issue.severity === "error") && screenshots.length === 3,
      hash,
      height,
      issues: unique.slice(0, CHECK_LIMITS.issues),
      calls: [...calls.values()],
      downloads,
      screenshots,
      aria,
    }),
  );
}
