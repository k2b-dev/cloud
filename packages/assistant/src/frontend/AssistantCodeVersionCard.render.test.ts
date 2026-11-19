import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import { approvalFixture, approvalModel, approvalNow, approvalStates, approvalVersionId } from "./code-version-card.test-fixture";
import { type CodeVersionCardModel, describeCodeVersionCard } from "./code-version-card-state";

registerSsrTestPlugin({ dev: true, rootDir: mkdtempSync(join(tmpdir(), "assistant-approval-render-")) });
const [{ CodeVersionCardView }, { LocaleProvider }] = await Promise.all([import("./code-version-card-view"), import("@k2b/ui")]);
beforeAll(() => setSystemTime(new Date(approvalNow)));
afterAll(() => setSystemTime());
const render = (model: CodeVersionCardModel, locale: string) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(CodeVersionCardView, { model, anchorId: "approval", onAction: () => {} });
      },
    }),
  );
const live = (html: string, role: string) =>
  (html.match(new RegExp(`<span role="${role}"[^>]*>([\\s\\S]*?)</span>`))?.[1] ?? "").replace(/<!--[\s\S]*?-->/g, "");

for (const locale of ["de", "en"])
  for (const state of approvalStates) {
    test(`${locale}: ${state} has one sentence, quiet line and at most two actions on one plum surface`, () => {
      const model = approvalModel(state, locale);
      const html = render(model, locale);
      expect(live(html, model.alert ? "alert" : "status")).toBe(model.main);
      expect(live(html, model.alert ? "status" : "alert")).toBe("");
      expect(html).toContain("k2b-notice-card__description");
      expect(html.match(/ti-shield-check/g)).toHaveLength(1);
      expect(html).not.toContain("k2b-chat-decision");
      expect(html.match(/data-code-version-primary/g)).toHaveLength(1);
      expect(html).not.toMatch(/home\.ts|months\.ts|settings\.ts/);
      expect(model.kind).toBe(state);
      if (state !== "on") expect(model.primary?.id).not.toBe("open");
    });
  }

test("the published server home is the primary page even when it is not first", () => {
  const value = approvalFixture("on");
  value.pages!.pages.reverse();
  const model = describeCodeVersionCard({
    value,
    version: 1,
    versionId: approvalVersionId,
    locale: "de",
    timeZone: "UTC",
    activation: { kind: "idle" },
    nextRun: null,
    canAsk: true,
  });
  expect(model.primary?.href).toBe("/code/c_info01/home");
  expect(model.secondary?.id).toBe("runs");
});

test("missing pages offer retry, while a real empty list offers runs and never invents Open", () => {
  for (const pages of [
    null,
    { versionId: approvalVersionId, homeUrl: null, pages: [] },
    { ...approvalFixture("on").pages!, versionId: "other" },
  ]) {
    const model = describeCodeVersionCard({
      value: { ...approvalFixture("on"), pages },
      version: 1,
      versionId: approvalVersionId,
      locale: "en",
      timeZone: "UTC",
      activation: { kind: "idle" },
      nextRun: null,
      canAsk: true,
    });
    expect(model.primary?.id).toBe(pages && pages.versionId === approvalVersionId ? "runs" : "load");
    const html = render(model, "en");
    const quiet = html.match(/<p class="k2b-notice-card__description"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "";
    if (pages && pages.versionId === approvalVersionId) {
      expect(model.secondary).toBeUndefined();
      expect(live(quiet, "alert")).toBe("");
    } else {
      expect(model.quietAlert).toBe(true);
      expect(live(quiet, "alert")).toBe("The other pages could not be loaded");
      expect(html).toContain("Try again");
    }
  }
});

test("loading, denial, unreadable state and failure keep the same surface and offer only truthful recovery", () => {
  for (const value of [null, "failed", "denied"] as const) {
    const model = describeCodeVersionCard({
      value,
      version: 1,
      versionId: approvalVersionId,
      locale: "de",
      timeZone: "UTC",
      activation: { kind: "idle" },
      nextRun: null,
      canAsk: true,
    });
    expect(render(model, "de")).toContain("k2b-notice-card");
    if (value === null) expect(render(model, "de")).toContain("data-reserve");
    expect(model.primary?.id).not.toBe("activate");
  }
});

test("the real deferred card server-renders authorized operating state and pages, rather than a mount placeholder", async () => {
  const { ApprovalSnapshotView } = await import("./code-version-card-ssr.test-fixture");
  const { approvalSnapshot } = await import("./code-version-card.test-fixture");
  const snapshot = approvalSnapshot("on");
  const html = renderToString(() =>
    createComponent(ApprovalSnapshotView, {
      initial: [{ codeId: snapshot.preview.codeId, versionId: snapshot.preview.versionId, state: "available", snapshot }],
    }),
  );
  expect(live(html, "status")).toBe("Version 1 ist eingeschaltet.");
  expect(html).toContain("Öffnen");
  expect(html).toContain("Weitere Seiten");
  expect(html).not.toContain("Diese Version wird geladen");
});

test("only a version that is already final when the chat draws it is a receipt without reserve", async () => {
  const { ApprovalSnapshotView } = await import("./code-version-card-ssr.test-fixture");
  const { approvalSnapshot } = await import("./code-version-card.test-fixture");
  const card = (state: "replaced" | "ready" | null) => {
    const html = renderToString(() =>
      createComponent(ApprovalSnapshotView, {
        initial: state ? [{ codeId: "c_info01", versionId: approvalVersionId, state: "available", snapshot: approvalSnapshot(state) }] : [],
      }),
    );
    // The card's own element, the only one with a state.
    return html.match(/<[^>]*\sdata-state="[^"]*"[^>]*>/)?.[0] ?? "";
  };
  expect(card("replaced")).toContain('data-state="replaced"');
  expect(card("replaced")).toContain("data-receipt");
  expect(card("ready")).not.toContain("data-receipt");
  // A card that turns into a receipt while in view keeps the receipt flag off: its reserve keeps the chat in place.
  const viewHtml = (state: (typeof approvalStates)[number], receipt: boolean) =>
    renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return createComponent(CodeVersionCardView, { model: approvalModel(state), anchorId: "a", onAction: () => {}, receipt });
        },
      }),
    );
  const view = (state: (typeof approvalStates)[number], receipt: boolean) => viewHtml(state, receipt).includes("data-receipt");
  expect(view("replaced", false)).toBe(false);
  expect(view("replaced", true)).toBe(true);
  const hasReserve = (state: (typeof approvalStates)[number], receipt: boolean) =>
    (viewHtml(state, receipt).match(/<[^>]*\sdata-approval-frame[^>]*>/)?.[0] ?? "").includes("data-reserve");
  expect(hasReserve("replaced", true)).toBe(false);
  expect(hasReserve("replaced", false)).toBe(true);
  expect(hasReserve("ready", true)).toBe(true);
  // A live state never sheds its reserve, also when the flag was set for the receipt it started as.
  for (const state of approvalStates.filter((state) => state !== "replaced")) expect([state, view(state, true)]).toEqual([state, false]);
});

test("checking shows the same facts as switching; only an unknown outcome asks the person to check", () => {
  const value = approvalFixture("ready");
  const model = (kind: "checking" | "progress" | "unknown") =>
    describeCodeVersionCard({
      value,
      version: 1,
      versionId: approvalVersionId,
      locale: "de",
      timeZone: "UTC",
      activation: { kind },
      nextRun: null,
      canAsk: true,
    });
  expect(model("checking").quiet).toBe(model("progress").quiet);
  expect(model("checking").quiet).toContain("liest Mails");
  expect(model("checking").quiet).not.toContain("Prüf den Stand");
  expect(model("unknown").quiet).toContain("Prüf den Stand");
});
