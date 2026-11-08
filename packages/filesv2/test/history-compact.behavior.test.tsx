import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { JSX } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { ActivityEntry } from "../src/activity-contracts";
import { chain, entry, env, gone, hidden, live, page, snapshot } from "./history-fixtures";

const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const valentin = { kind: "user" as const, userId: "valentin", name: "Valentin Kolb" };
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 20, 10, 54, seconds)).toISOString();

/** The API bulk case from the feedback: each file renamed in Inbox, then moved on; newest first. */
const bulk = (count: number) =>
  Array.from({ length: count }, (_, index) => {
    const name = `Rechnung-${index + 1}.pdf`;
    return [
      entry({
        action: "item.move",
        time: at(50 - index * 2),
        actor: valentin,
        via: "api",
        before: snapshot(`vertrieb/Inbox/${name}`, { directory: false }),
        after: live(`vertrieb/Buchhaltung/ebay/${name}`, { directory: false }),
      }),
      entry({
        action: "item.rename",
        time: at(49 - index * 2),
        actor: valentin,
        via: "api",
        before: snapshot(`vertrieb/Inbox/scan-${index + 1}.pdf`, { directory: false }),
        after: snapshot(`vertrieb/Inbox/${name}`, { directory: false }),
      }),
    ];
  }).flat();

describe("compact activity rows", () => {
  if (isServer) {
    test.skip("requires the package DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => cleanup());
  let dom!: ReturnType<typeof createDomTestHarness>;
  beforeEach(() => {
    dom = createDomTestHarness();
    cleanup = () => dom.cleanup();
  });
  const view = async (items: ActivityEntry[]) => {
    const { LocaleProvider } = await import("@k2b/ui");
    const { default: ActivityView } = await import("../src/frontend/ActivityView");
    const element = (): JSX.Element => (
      <LocaleProvider locale="de">
        <ActivityView
          env={env}
          filters={{}}
          onFiltersChange={() => {}}
          bases={[{ id: "cloud:groups:vertrieb", label: "Team Vertrieb" }]}
          people={[]}
          initial={{ filters: {}, page: page(items) }}
          load={async () => page(items)}
          loadChain={async () => chain({})}
          retentionDays={365}
        />
      </LocaleProvider>
    );
    let dispose = render(element, dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await flush();
    return {
      remount: async () => {
        dispose();
        dom.root.textContent = "";
        dispose = render(element, dom.root);
        await flush();
      },
    };
  };
  const links = () => [...dom.root.querySelectorAll<HTMLAnchorElement>(".filesv2-history-target")];

  test("a current file is a link into its folder, its folders open, and a vanished one is plain with a hint", async () => {
    await view([
      entry({
        action: "item.move",
        actor: valentin,
        before: snapshot("vertrieb/Inbox/A.pdf", { directory: false }),
        after: live("vertrieb/Buchhaltung/A.pdf", { directory: false }),
      }),
      entry({ action: "file.upload", before: hidden, after: gone("vertrieb/Inbox/Alt.pdf", { directory: false }) }),
    ]);
    const rows = [...dom.root.querySelectorAll("article.filesv2-history-row")];
    expect(rows.map((row) => row.getAttribute("data-variant"))).toEqual(["compact", "compact"]);
    expect(links().map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["A.pdf", "/app/filesv2?base=cloud%3Agroups%3Avertrieb&path=Buchhaltung&file=Buchhaltung%2FA.pdf"],
      ["Team Vertrieb", "/app/filesv2?base=cloud%3Agroups%3Avertrieb"],
      ["Buchhaltung", "/app/filesv2?base=cloud%3Agroups%3Avertrieb&path=Buchhaltung"],
    ]);
    expect(rows[1]!.textContent).toContain("Lukas Pohl hat Alt.pdf (nicht mehr verfügbar) hochgeladen");
    expect(rows[1]!.querySelector("a")).toBeNull();
    // Time and channel sit at the end of the line, the channel as a small tag.
    expect(rows[0]!.querySelector(".filesv2-history-row__facts time")?.textContent).toBe("14:12");
    expect(rows[1]!.querySelector(".filesv2-history-row__facts .k2b-tag")?.textContent).toBe("Web");
  });

  test("links come only from current sides the reader returned; a hidden side adds no name, folder or address", async () => {
    await view([
      entry({ action: "item.move", before: gone("vertrieb/Kunden/Bericht.pdf", { directory: false }), after: hidden }),
      entry({ action: "item.copy", before: hidden, after: live("vertrieb/Archiv/Kopie.pdf", { directory: false }) }),
      // A stored snapshot names the place but never leads there.
      entry({ action: "item.move", before: hidden, after: snapshot("vertrieb/Privat/Notiz.pdf", { directory: false }) }),
    ]);
    const rows = [...dom.root.querySelectorAll("article.filesv2-history-row")];
    expect(rows[0]!.textContent).toContain(
      "Lukas Pohl hat Bericht.pdf (nicht mehr verfügbar) verschoben, an einen Ort, den du nicht sehen kannst",
    );
    expect(rows[0]!.querySelector("a")).toBeNull();
    expect(rows[1]!.textContent).toContain("von einem Ort, den du nicht sehen kannst");
    expect(rows[2]!.querySelector("a")).toBeNull();
    expect(links().map((link) => link.textContent)).toEqual(["Kopie.pdf", "Team Vertrieb", "Archiv"]);
    expect(links().every((link) => !link.getAttribute("href")!.includes("Kunden") && !link.getAttribute("href")!.includes("Privat"))).toBe(
      true,
    );
  });

  test("a bulk rename and move reads as one expandable line; opening keeps focus, survives coming back, and leaves the line in place", async () => {
    const page = await view(bulk(12));
    const toggle = dom.root.querySelector<HTMLButtonElement>("button.filesv2-history-run__toggle")!;
    expect(toggle.textContent).toContain("Valentin Kolb hat 12 Dateien umbenannt und verschoben");
    expect(toggle.querySelector(".k2b-tag")?.textContent).toBe("API");
    expect(toggle.querySelector("time")?.textContent).toBe("12:54");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const rows = dom.root.querySelector<HTMLUListElement>(`#${toggle.getAttribute("aria-controls")}`)!;
    expect(rows.hidden).toBe(true);
    expect(rows.querySelectorAll("article")).toHaveLength(12);
    const before = toggle.outerHTML.replace(/ aria-expanded="false"/, "");
    toggle.focus();
    toggle.click();
    await flush();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(rows.hidden).toBe(false);
    expect(document.activeElement).toBe(toggle);
    // The line itself does not change: only its state attribute and the rows below it.
    expect(toggle.outerHTML.replace(/ aria-expanded="true"/, "")).toBe(before);
    const first = rows.querySelector("article")!;
    // The run names the actor; its lines name only the change.
    expect(first.textContent).toContain("scan-1.pdf → Rechnung-1.pdf, nach Team Vertrieb › Buchhaltung › ebay verschoben");
    expect(first.textContent).not.toContain("Valentin Kolb");
    // Rows inside a run leave the repeated avatar out.
    expect(first.querySelector(".filesv2-history-row__who[data-repeat]")).not.toBeNull();
    expect(first.querySelector("a.filesv2-history-target--name")?.getAttribute("href")).toContain(
      "file=Buchhaltung%2Febay%2FRechnung-1.pdf",
    );
    // Coming back from an opened file shows the run as it was left.
    await page.remount();
    expect(dom.root.querySelector("button.filesv2-history-run__toggle")?.getAttribute("aria-expanded")).toBe("true");
    dom.root.querySelector<HTMLButtonElement>("button.filesv2-history-run__toggle")!.click();
    await flush();
    expect(dom.root.querySelector("button.filesv2-history-run__toggle")?.getAttribute("aria-expanded")).toBe("false");
  });

  test("four merged changes stay single lines, and a repeated actor shows its avatar once", async () => {
    await view(bulk(4));
    expect(dom.root.querySelector(".filesv2-history-run__toggle")).toBeNull();
    const rows = [...dom.root.querySelectorAll("article.filesv2-history-row")];
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.querySelector(".filesv2-history-row__who")?.hasAttribute("data-repeat"))).toEqual([
      false,
      true,
      true,
      true,
    ]);
  });
});
