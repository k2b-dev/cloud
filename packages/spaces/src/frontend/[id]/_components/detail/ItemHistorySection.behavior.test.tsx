import { afterEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    const { default: ItemHistorySection } = await import("./ItemHistorySection");
    const { LocaleProvider } = await import("@k2b/ui");
    return { ItemHistorySection, LocaleProvider };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

const entry = (id: string, sentence: string, origin?: { name: string; href: string | null; runHref: string | null }) => ({
  row: { id, at: "2026-11-01T09:41:00.000Z", icon: "ti ti-code", sentence, count: 1, ...(origin ? { origin } : {}) },
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe.skipIf(isServer)("A card's history", () => {
  const realFetch = globalThis.fetch;
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    globalThis.fetch = realFetch;
  });
  const mount = () => {
    const dom = createDomTestHarness();
    const { ItemHistorySection, LocaleProvider } = modules!;
    const dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "de",
          get children() {
            return createComponent(ItemHistorySection, { spaceId: "abc123", itemId: "def456" });
          },
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    return dom;
  };

  test("links the work's name inside the sentence and its run beside the time, only when the viewer may follow", async () => {
    globalThis.fetch = (async () =>
      json({
        data: [
          entry("1", "Angelegt von Code von info@ (Lieferungen eintragen)", {
            name: "Code von info@",
            href: "/app/mail/m1/code",
            runHref: "/app/mail/m1/code?tab=runs&run=r1",
          }),
          entry("2", "Angelegt von Code (gelöscht)", { name: "Code (gelöscht)", href: null, runHref: null }),
        ],
        nextCursor: null,
      })) as typeof fetch;
    const dom = mount();
    await settle();
    const links = Array.from(dom.document.querySelectorAll("a")).map((link) => [link.textContent, link.getAttribute("href")]);
    expect(links).toEqual([
      ["Code von info@", "/app/mail/m1/code"],
      ["Lauf öffnen", "/app/mail/m1/code?tab=runs&run=r1"],
    ]);
    expect(dom.document.body.textContent).toContain("Angelegt von Code (gelöscht)");
  });

  test("a failed load says so and retries in place", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1 ? json({ message: "down" }, 503) : json({ data: [entry("1", "Ben hat die Aufgabe erstellt")], nextCursor: null });
    }) as typeof fetch;
    const dom = mount();
    await settle();
    expect(dom.document.querySelector('[role="alert"]')?.textContent).toContain("Der Verlauf konnte nicht geladen werden.");
    dom.document.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    await settle();
    expect(dom.document.body.textContent).toContain("Ben hat die Aufgabe erstellt");
    expect(dom.document.querySelector('[role="alert"]')).toBeNull();
  });
});
