import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

// The per-tab memory behind the way up, in a document: what it remembers, where
// going up leads, and which row it marks after returning. Real scrolling and
// page loads run in `page-trail.browser.test.ts`.
const load = async () => {
  const dom = createDomTestHarness();
  try {
    return {
      runtime: await import("./page-trail-runtime"),
      layout: (await import("./layout-runtime")).layout,
      ui: await import("@k2b/ui"),
    };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

const open = () => {
  const dom = createDomTestHarness();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: dom.window.sessionStorage });
  const loads: string[] = [];
  Object.assign(dom.window.location, { assign: (href: string) => loads.push(href) });
  return {
    dom,
    loads,
    /** Shows a page: its address and its trail, as the shell publishes them. */
    visit: (url: string, ancestors: string[] = []) => {
      dom.window.history.replaceState(null, "", url);
      modules!.ui.setPageTrail({ title: url, ancestors: ancestors.map((href) => ({ title: href, href })) });
    },
    close: () => {
      Reflect.deleteProperty(globalThis, "sessionStorage");
      dom.cleanup();
    },
  };
};
const frames = async (count = 5) => {
  for (let index = 0; index < count; index++) await new Promise((done) => requestAnimationFrame(done));
};

if (isServer) test.skip("requires browser conditions", () => {});
else {
  const { rememberPage, upDestination, goUp, installPageTrailRuntime } = modules!.runtime;
  const labels = (page: string) => ({ title: `Up to ${page}`, description: "Up" });

  test("going up from a page never leads back to it or to another page below the parent", () => {
    const tab = open();
    try {
      // A Files document carries its folder's query plus `view=edit`; its way up names the folder with its row.
      const parent = "/app/filesv2?base=b1&path=Projects&file=Projects%2Fplan.md";
      tab.visit("/app/filesv2?base=b1&path=Projects");
      rememberPage();
      tab.visit(`${parent}&view=edit`, [parent]);
      rememberPage();
      expect(upDestination(parent)).toBe(parent);

      // A list keeps its filter; a sibling detail visited since is below the list and does not count.
      tab.visit("/app/things?q=red");
      rememberPage();
      tab.visit("/app/things?item=41", ["/app/things"]);
      rememberPage();
      tab.visit("/app/things?item=42", ["/app/things"]);
      expect(upDestination("/app/things")).toBe("/app/things?q=red");
      goUp("/app/things");
      expect(tab.loads).toEqual(["http://localhost/app/things?q=red"]);
    } finally {
      tab.close();
    }
  });

  test("an island that navigates in place takes the way up, and the page stays", () => {
    const tab = open();
    const taken: string[] = [];
    const stop = modules!.layout.handleUp((href) => {
      taken.push(href);
      return href.startsWith("/app/filesv2");
    });
    try {
      tab.visit("/app/filesv2?base=b1&path=Projects%2F2026", ["/app/filesv2?base=b1&path=Projects"]);
      goUp("/app/filesv2?base=b1&path=Projects");
      expect(taken).toEqual(["/app/filesv2?base=b1&path=Projects"]);
      expect(tab.loads).toEqual([]);
      // Somewhere the island does not handle, the page loads.
      tab.visit("/app/filesv2/shares", ["/app/mail"]);
      goUp("/app/mail");
      expect(tab.loads).toEqual(["http://localhost/app/mail"]);
    } finally {
      stop();
      tab.close();
    }
  });

  test("the way up never leaves this origin", () => {
    const tab = open();
    const taken: string[] = [];
    const stop = modules!.layout.handleUp((href) => {
      taken.push(href);
      return false;
    });
    try {
      tab.visit("/app/things?item=41", ["javascript:alert(1)", "https://elsewhere.example/app/things"]);
      expect(goUp("javascript:alert(1)")).toBe(false);
      expect(goUp("https://elsewhere.example/app/things")).toBe(false);
      expect({ taken, loads: tab.loads }).toEqual({ taken: [], loads: [] });
      // A same-origin path that starts with `//` would read as another host, so it names no page above.
      expect(goUp("http://localhost//elsewhere.example/app")).toBe(false);
      expect({ taken, loads: tab.loads }).toEqual({ taken: [], loads: [] });
      // Parsing a remembered path must not turn it into another host for an island.
      sessionStorage.setItem(
        "cloud:page-trail",
        JSON.stringify({
          visits: [
            { url: "/..//elsewhere.example/app", regions: [] },
            { url: "/./\\elsewhere.example/app", regions: [] },
          ],
        }),
      );
      expect(goUp("http://localhost//elsewhere.example/app")).toBe(false);
      expect({ taken, loads: tab.loads }).toEqual({ taken: [], loads: [] });
    } finally {
      stop();
      tab.close();
    }
  });

  test("a trail link the way up does not take stays a plain link", () => {
    const tab = open();
    const stop = installPageTrailRuntime(labels);
    try {
      tab.visit("/app/x", ["/app/things"]);
      const plain = document.createElement("a");
      plain.setAttribute("data-k2b-page-trail-link", "");
      plain.href = "http://localhost//app/things";
      const up = document.createElement("a");
      up.setAttribute("data-k2b-page-trail-link", "");
      up.href = "/app/things";
      document.body.append(plain, up);
      // A path that names no page above stays a plain link.
      const plainClick = new MouseEvent("click", { button: 0, bubbles: true, cancelable: true });
      plain.dispatchEvent(plainClick);
      expect(plainClick.defaultPrevented).toBe(false);
      expect(tab.loads).toEqual([]);
      // A page above is taken by the runtime and cancels the anchor's activation.
      const upClick = new MouseEvent("click", { button: 0, bubbles: true, cancelable: true });
      up.dispatchEvent(upClick);
      expect(upClick.defaultPrevented).toBe(true);
      expect(tab.loads).toEqual(["http://localhost/app/things"]);
    } finally {
      stop();
      tab.close();
    }
  });

  test("a malformed memory entry is ignored, never thrown", async () => {
    const tab = open();
    try {
      tab.visit("/app/x", ["/app/things"]);
      // Malformed ancestors and scroll regions do not count as visits.
      sessionStorage.setItem(
        "cloud:page-trail",
        JSON.stringify({
          visits: [
            { url: "/app/things?q=a", regions: [], up: "x" },
            { url: "/app/things?q=b", regions: [], up: ["http://["] },
            { url: "/app/things?q=c", regions: {} },
            { url: "/app/things?q=d", regions: [{ key: 1, top: 0, left: 0 }] },
            { url: "/app/things?q=e", regions: [{ key: "@main", top: "1", left: 0 }] },
          ],
        }),
      );
      expect(upDestination("/app/things")).toBe("/app/things");
      expect(goUp("/app/things")).toBe(true);
      expect(tab.loads).toEqual(["http://localhost/app/things"]);
      const row = document.createElement("a");
      row.href = "/app/things";
      document.body.append(row);
      // A malformed return neither throws during installation nor marks a row later.
      for (const returning of [
        { url: "http://[", from: "/app/things" },
        { url: "/app/current", from: 5 },
        { url: "//evil.example/app/current", from: "/app/things" },
      ]) {
        tab.visit("/app/current");
        sessionStorage.setItem("cloud:page-trail", JSON.stringify({ visits: [{ url: "/app/current", regions: {} }], returning }));
        expect(() => installPageTrailRuntime(labels)()).not.toThrow();
        await frames();
        expect(document.querySelector("[data-page-trail-recent]")).toBeNull();
      }
    } finally {
      tab.close();
    }
  });

  test("going up keeps a remembered page's query and hash and loads it on this origin", () => {
    const tab = open();
    const taken: string[] = [];
    const stop = modules!.layout.handleUp((href) => {
      taken.push(href);
      return false;
    });
    try {
      tab.visit("/app/things?q=red#row-4");
      rememberPage();
      tab.visit("/app/things?item=41", ["/app/things"]);
      goUp("/app/things");
      expect(taken).toEqual(["/app/things?q=red#row-4"]);
      expect(tab.loads).toEqual(["http://localhost/app/things?q=red#row-4"]);
      // A parent never visited loads at its own path.
      tab.visit("/app/mail/m1", ["/app/mail"]);
      goUp("/app/mail");
      expect(taken).toEqual(["/app/things?q=red#row-4", "/app/mail"]);
      expect(tab.loads).toEqual(["http://localhost/app/things?q=red#row-4", "http://localhost/app/mail"]);
    } finally {
      stop();
      tab.close();
    }
  });

  // Both relative addresses resolve to the parent, but after the origin as text either one names another host.
  test.each(["@evil.example/../things", ".evil.example/../../app/things"])("a tampered memory entry is ignored (%s)", (tampered) => {
    const tab = open();
    const taken: string[] = [];
    const stop = modules!.layout.handleUp((href) => {
      taken.push(href);
      return false;
    });
    try {
      tab.visit("/app/x", ["/app/things"]);
      const urls = [tampered, "//evil.example/app/things", "/\\evil.example/app/things", "javascript:alert(1)"];
      sessionStorage.setItem("cloud:page-trail", JSON.stringify({ visits: [...urls.map((url) => ({ url, regions: [] })), null] }));
      expect(upDestination("/app/things")).toBe("/app/things");
      goUp("/app/things");
      expect(taken).toEqual(["/app/things"]);
      expect(tab.loads).toEqual(["http://localhost/app/things"]);
      rememberPage();
      expect(JSON.parse(sessionStorage.getItem("cloud:page-trail") ?? "null").visits).toEqual([
        { url: "/app/x", regions: [], up: ["/app/things"] },
      ]);
    } finally {
      stop();
      tab.close();
    }
  });

  test("Enter remembers the page before an in-place navigation, as a click does", () => {
    const tab = open();
    const stop = installPageTrailRuntime(labels);
    try {
      tab.visit("/app/filesv2?base=b1&path=Projects&sort=size");
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      tab.visit("/app/filesv2?base=b1&path=Projects%2F2026", ["/app/filesv2?base=b1&path=Projects"]);
      expect(upDestination("/app/filesv2?base=b1&path=Projects")).toBe("/app/filesv2?base=b1&path=Projects&sort=size");
    } finally {
      stop();
      tab.close();
    }
  });

  test("after going up, the row of the page left is marked, not a link to the whole list", async () => {
    const tab = open();
    tab.visit("/app/things");
    sessionStorage.setItem(
      "cloud:page-trail",
      JSON.stringify({ visits: [], returning: { url: "/app/things", from: "/app/things?item=42" } }),
    );
    const main = document.createElement("main");
    main.className = "layout-content-main";
    main.innerHTML = `<a href="/app/things">All things</a><ul><li><a href="/app/things?item=41">41</a></li><li><a href="/app/things?item=42&amp;q=red">42</a></li></ul>`;
    document.body.append(main);
    const stop = installPageTrailRuntime(labels);
    try {
      await frames();
      expect([...document.querySelectorAll("[data-page-trail-recent]")].map((element) => element.textContent)).toEqual(["42"]);
    } finally {
      stop();
      tab.close();
    }
  });

  test("layout.update() drops a link to the page itself once the address names it, and keeps the page just left", async () => {
    const tab = open();
    try {
      // Re-sending the array the server rendered: the app's home links to itself.
      tab.visit("/apps/shop");
      modules!.layout.update({ breadcrumbs: [{ title: "Bookshop", href: "/apps/shop" }, { title: "Catalog" }] });
      await Promise.resolve();
      expect(modules!.ui.readPageTrail()).toEqual({ title: "Catalog", ancestors: [] });
      // An island that updates first and then pushes the new address in the same task keeps its parent.
      tab.visit("/app/notebooks/abc");
      modules!.layout.update({ breadcrumbs: [{ title: "Notebook", href: "/app/notebooks/abc" }, { title: "Note" }] });
      tab.dom.window.history.pushState(null, "", "/app/notebooks/abc/n1");
      await Promise.resolve();
      expect(modules!.ui.readPageTrail()?.ancestors).toEqual([{ title: "Notebook", href: "/app/notebooks/abc" }]);
    } finally {
      tab.close();
    }
  });

  test("an anonymous or focus-mode page keeps its title alone after layout.update()", () => {
    const tab = open();
    const canvas = document.createElement("div");
    canvas.className = "cloud-app-canvas";
    canvas.setAttribute("data-page-trail-title-only", "");
    document.body.append(canvas);
    try {
      tab.visit("/app/mail/compose");
      modules!.layout.update({ breadcrumbs: [{ title: "Inbox", href: "/app/mail/m1" }, { title: "New message" }] });
      expect(modules!.ui.readPageTrail()).toEqual({ title: "New message", ancestors: [] });
    } finally {
      tab.close();
    }
  });
}
