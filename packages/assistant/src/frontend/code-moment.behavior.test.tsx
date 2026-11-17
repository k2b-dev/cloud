import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { createComponent, type JSX } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

// One moment of a Code reads the same in the chat's event line, on the version card and on the Code page.
const dom = isServer ? undefined : createDomTestHarness();
const ui = isServer ? undefined : await import("@k2b/ui");
const fixture = isServer ? undefined : await import("@k2b/cloud/ssr/code-page/code-page.fixture");
const codePage = isServer ? undefined : await import("@k2b/cloud/ssr/code-page");
const line = isServer ? undefined : await import("./AssistantCodeDecisionLine");
const card = isServer ? undefined : await import("./AssistantCodeVersionCard");
const live = isServer ? undefined : await import("./assistant-live");
process.once("exit", () => dom?.cleanup());

const restore: Array<() => void> = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

// The Code page fixture's clock: Saturday, 14 November 2026, 13:49 in Berlin.
const NOW = "2026-11-14T12:49:00.000Z";
// Thursday, 12 November 2026, 15:28 in Berlin: this year, not today, and far enough back to read as a date.
const INSTANT = "2026-11-12T14:28:00.000Z";
const MOMENT = "Do, 12.11., 15:28";
const TIME_ZONE = "Europe/Berlin";
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const text = (root: Element) => (root.textContent ?? "").replace(/\s+/g, " ").trim();

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div");
  document.body.append(host);
  const stop = render(
    () =>
      createComponent(ui!.LocaleProvider, {
        locale: "de",
        get children() {
          return view();
        },
      }),
    host,
  );
  restore.push(() => {
    stop();
    host.remove();
  });
  return host;
};

if (isServer) test.skip("requires browser conditions", () => {});
else
  test("the event line, the version card and the Code page write one moment the same way", async () => {
    setSystemTime(new Date(NOW));
    restore.push(() => setSystemTime());

    // The chat's event line about a decision at that moment.
    const decision = mount(() =>
      createComponent(line!.default, {
        decision: {
          codeId: "c_info01",
          versionId: "66666666-6666-4666-8666-666666666666",
          number: 5,
          outcome: "rejected",
          person: { id: "u-jana", name: "Jana Probe" },
          anchor: "code-version-66666666-6666-4666-8666-666666666666",
        },
        at: INSTANT,
        timeZone: TIME_ZONE,
      }),
    );

    // The version card of a version switched on at that moment; Core answers its preview, review and words.
    const preview = {
      codeId: "c_info01",
      title: "Code von info@",
      ownerKind: "resource",
      versionId: "66666666-6666-4666-8666-666666666666",
      number: 5,
      running: 5,
      latest: 5,
      activated: { at: INSTANT, byYou: true, byName: null },
      allowed: { allowed: true },
      readiness: { state: "ready" },
      place: null,
    };
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
      const route = String(url);
      if (route.endsWith("/api/code/activation/preview")) return new Response(JSON.stringify({ data: preview }));
      return new Response("{}", { status: 503 });
    }) as unknown as typeof fetch);
    restore.push(() => fetchSpy.mockRestore());
    const hub = live!.createAssistantLiveHub();
    const version = mount(() =>
      createComponent(live!.AssistantLiveProvider, {
        value: hub,
        get children() {
          return createComponent(card!.default, {
            codeId: "c_info01",
            versionId: "66666666-6666-4666-8666-666666666666",
            number: 5,
            timeZone: TIME_ZONE,
          });
        },
      }),
    );

    // The Code page, whose first automation last ran at that moment.
    const data = fixture!.codePageFixture("overview", "de");
    if (data.state.kind !== "ready") throw new Error("The overview fixture is ready");
    const state = data.state;
    const [first, ...rest] = state.automations ?? [];
    if (!first?.lastRun) throw new Error("The overview fixture's first automation has a last run");
    const page = mount(() =>
      createComponent(codePage!.default, {
        data: {
          ...data,
          state: {
            ...state,
            automations: [{ ...first, lastRun: { ...first.lastRun!, createdAt: INSTANT } }, ...rest],
            // The live overview starts from the run list; both snapshots describe this same immutable run.
            runs: state.runs && {
              ...state.runs,
              items: state.runs.items.map((run) => (run.id === first.lastRun!.id ? { ...run, createdAt: INSTANT } : run)),
            },
          },
        },
      }),
    );
    await tick();

    expect(text(decision)).toContain(`· ${MOMENT}`);
    expect(text(version)).toContain(`Version 5 ist seit ${MOMENT} eingeschaltet.`);
    expect(text(page)).toContain(MOMENT);
  });
