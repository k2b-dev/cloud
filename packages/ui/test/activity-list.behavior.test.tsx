import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { createSignal, type JSX } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "./dom";

// Thursday, 12 Nov 2026, 16:31 in Berlin: the "now" of the approved mockup. The clock is frozen; the test moves it.
const NOW = "2026-11-12T15:31:00Z";
const ZONE = "Europe/Berlin";

type Setup = { dom: DomTestHarness; dispose: () => void; tick: () => void };
let current: Setup | undefined;
afterEach(() => {
  current?.dispose();
  current?.dom.cleanup();
  current = undefined;
  setSystemTime();
});

/** Renders with the clock at NOW; `tick` moves it on by a minute and runs the list's minute timer. */
const mount = async (view: (lib: typeof import("../src/content/ActivityList")) => () => JSX.Element): Promise<Setup> => {
  setSystemTime(new Date(NOW));
  const dom = createDomTestHarness();
  dom.document.documentElement.lang = "en";
  const lib = await import("../src/content/ActivityList");
  const minutes: Array<() => void> = [];
  const interval = spyOn(globalThis, "setInterval");
  let dispose: () => void;
  try {
    dispose = render(view(lib), dom.root);
    for (const [handler] of interval.mock.calls) {
      if (typeof handler === "function") minutes.push(() => handler());
    }
  } finally {
    interval.mockRestore();
  }
  let at = Date.parse(NOW);
  const tick = () => {
    at += 60_000;
    setSystemTime(new Date(at));
    for (const minute of minutes) minute();
  };
  current = { dom, dispose, tick };
  return current;
};

const rowOf = (root: HTMLElement, text: string) =>
  Array.from(root.querySelectorAll<HTMLElement>(".k2b-activity__entry")).find((row) => row.textContent?.includes(text));

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("the minute clock moves the times but keeps bundle sentences and folded-out details", async () => {
    const draft = (minute: string) => ({
      at: `2026-11-12T16:${minute}:00+01:00`,
      icon: "ti ti-pencil",
      text: "Entwurf geändert",
      bundle: { key: "draft", text: (count: number) => <span data-bundle="">{`Entwurf ${count}-mal geändert`}</span> },
      actor: "Elif Kaya",
    });
    const entries = [
      { at: "2026-11-12T16:20:00+01:00", icon: "ti ti-mail", text: "Per E-Mail gesendet", details: () => <input data-field="" /> },
      draft("10"),
      draft("05"),
    ];
    const { dom, tick } = await mount(({ ActivityList }) => () => <ActivityList entries={entries} now={NOW} timeZone={ZONE} />);
    const mail = rowOf(dom.root, "Per E-Mail gesendet")!;
    mail.querySelector<HTMLButtonElement>(".k2b-activity__text-button")!.click();
    const field = dom.root.querySelector<HTMLInputElement>("[data-field]")!;
    field.value = "halb getippt";
    const bundle = dom.root.querySelector("[data-bundle]");
    expect(bundle?.textContent).toBe("Entwurf 2-mal geändert");
    expect(mail.querySelector("time [aria-hidden]")?.textContent).toBe("16:20");

    expect(mail.querySelector("time .k2b-sr-only")?.textContent).toContain("11 min. ago");
    tick();
    expect(mail.querySelector("time .k2b-sr-only")?.textContent).toContain("12 min. ago");

    expect(mail.querySelector("time [aria-hidden]")?.textContent).toBe("16:20");
    expect(dom.root.querySelector("[data-field]")).toBe(field);
    expect(field.value).toBe("halb getippt");
    expect(dom.root.querySelector("[data-bundle]")).toBe(bundle);
  });

  test("a click inside folded-out details or at the end of a text selection leaves the row as it is", async () => {
    const entries = [
      { at: "2026-11-12T16:20:00+01:00", icon: "ti ti-mail", text: "Per E-Mail gesendet", details: () => <p data-inside="">Betreff</p> },
    ];
    const { dom } = await mount(({ ActivityList }) => () => <ActivityList entries={entries} now={NOW} timeZone={ZONE} />);
    const row = rowOf(dom.root, "Per E-Mail gesendet")!;
    const sentence = row.querySelector<HTMLButtonElement>(".k2b-activity__text-button")!;
    const meta = row.querySelector<HTMLElement>(".k2b-activity__meta")!;
    meta.click();
    expect(sentence.getAttribute("aria-expanded")).toBe("true");
    dom.root.querySelector<HTMLElement>("[data-inside]")!.click();
    expect(sentence.getAttribute("aria-expanded")).toBe("true");
    // Selecting the time with the mouse ends in a click on the row; it must not fold.
    const time = meta.querySelector("time [aria-hidden]")!.firstChild!;
    dom.document.getSelection()!.setBaseAndExtent(time, 0, time, 5);
    meta.click();
    expect(sentence.getAttribute("aria-expanded")).toBe("true");
    dom.document.getSelection()!.removeAllRanges();
    meta.click();
    expect(sentence.getAttribute("aria-expanded")).toBe("false");
  });

  test("a linked row follows its link on a click anywhere and opens a new tab with a modifier or the middle button", async () => {
    const entries = [{ at: "2026-11-12T16:20:00+01:00", icon: "ti ti-check", text: "Aufgabe erledigt", href: "/app/spaces/s1?item=i1" }];
    const { dom } = await mount(({ ActivityList }) => () => <ActivityList entries={entries} now={NOW} timeZone={ZONE} />);
    const row = rowOf(dom.root, "Aufgabe erledigt")!;
    const link = row.querySelector<HTMLAnchorElement>("a.k2b-activity__text-link")!;
    expect(link.getAttribute("href")).toBe("/app/spaces/s1?item=i1");
    expect(row.hasAttribute("data-clickable")).toBe(true);
    let followed = 0;
    link.addEventListener("click", (event) => {
      followed++;
      event.preventDefault();
    });
    const opened = spyOn(dom.window, "open").mockImplementation(() => null);
    try {
      const meta = row.querySelector<HTMLElement>(".k2b-activity__meta")!;
      meta.click();
      expect(followed).toBe(1);
      meta.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
      meta.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
      expect(followed).toBe(1);
      expect(opened.mock.calls).toEqual([
        ["/app/spaces/s1?item=i1", "_blank", "noopener"],
        ["/app/spaces/s1?item=i1", "_blank", "noopener"],
      ]);
      // The link itself keeps its own click; the row does not follow it a second time.
      link.click();
      expect(followed).toBe(2);
    } finally {
      opened.mockRestore();
    }
  });

  test("with an id a row keeps its node and its open details when the entries are built anew", async () => {
    const build = () => [
      { id: "e2", at: "2026-11-12T16:25:00+01:00", icon: "ti ti-pencil", text: "Bearbeitet" },
      { id: "e1", at: "2026-11-12T16:20:00+01:00", icon: "ti ti-mail", text: "Per E-Mail gesendet", details: () => "Betreff" },
    ];
    const [entries, setEntries] = createSignal(build());
    const { dom } = await mount(({ ActivityList }) => () => <ActivityList entries={entries()} now={NOW} timeZone={ZONE} />);
    const row = rowOf(dom.root, "Per E-Mail gesendet")!;
    row.querySelector<HTMLButtonElement>(".k2b-activity__text-button")!.click();
    setEntries(build());
    expect(rowOf(dom.root, "Per E-Mail gesendet")).toBe(row);
    expect(row.querySelector(".k2b-activity__details")?.textContent).toBe("Betreff");
  });

  test("a feed row follows the parent's clock and selection without replacing the focused link", async () => {
    const [now, setNow] = createSignal(NOW);
    const [selected, setSelected] = createSignal(false);
    let navigated = 0;
    const { dom } = await mount(({ ActivityList }) => () => (
      <ActivityList.Row
        entry={{ at: "2026-11-12T16:20:00+01:00", text: "Kommentar ergänzt", actor: "Mira Lang", href: "/conversation" }}
        now={now()}
        timeZone={ZONE}
        selected={selected()}
        onNavigate={(event) => {
          event.preventDefault();
          navigated++;
        }}
      />
    ));
    const row = rowOf(dom.root, "Kommentar ergänzt")!;
    const link = row.querySelector<HTMLAnchorElement>("a")!;
    link.focus();
    expect(row.querySelector("time .k2b-sr-only")?.textContent).toContain("11 min. ago");
    setNow("2026-11-12T15:32:00Z");
    setSelected(true);
    expect(row.querySelector("time .k2b-sr-only")?.textContent).toContain("12 min. ago");
    expect(rowOf(dom.root, "Kommentar ergänzt")).toBe(row);
    expect(dom.document.activeElement).toBe(link);
    expect(link.getAttribute("aria-current")).toBe("true");
    row.querySelector<HTMLElement>(".k2b-activity__meta")!.click();
    expect(navigated).toBe(1);
  });
}
