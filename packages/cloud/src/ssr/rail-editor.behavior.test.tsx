import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

const settle = async (done: () => boolean) => {
  for (let attempt = 0; !done() && attempt < 200; attempt += 1) await Bun.sleep(5);
};

test("the editor saves the names setting, and the open page's app bar follows without a reload", async () => {
  const dom = createDomTestHarness();
  const saved = { revision: 2, visibility: {}, shortcuts: [], showNames: true };
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<script id="cloud-shell-data" type="application/json">${JSON.stringify({ apps: [], rail: saved, legalLinks: [], theme: "light", searchLinks: {} })}</script>`,
  );
  const canvas = document.createElement("div");
  canvas.className = "cloud-app-canvas";
  canvas.innerHTML = '<aside class="layout-rail" data-rail-names=""><nav></nav></aside>';
  document.body.append(canvas);
  const writes: unknown[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://cloud.test"), init);
        if (new URL(request.url).pathname !== "/api/me/rail") throw new Error(`Unexpected request ${request.url}`);
        if (request.method !== "PUT") return Response.json(saved);
        const body = await request.json();
        writes.push(body);
        return Response.json({ ...body, revision: 3 });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const { default: RailApps } = await import("./RailApps");
  const dispose = render(() => createComponent(RailApps, { apps: [], settings: saved, currentPath: "/" }), canvas.querySelector("nav")!);
  try {
    const { openRailEditor } = await import("./RailEditor");
    openRailEditor("en");
    const names = () => document.querySelector<HTMLInputElement>('dialog input[role="switch"]');
    await settle(() => !!names());
    expect(names()?.closest("label")?.textContent).toBe("Show names in the app bar");
    expect(names()?.checked).toBe(true);
    names()!.click();
    const save = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find((button) => button.textContent === "Save")!;
    expect(save.disabled).toBe(false);
    save.click();
    await settle(() => writes.length > 0 && !document.querySelector("dialog[open]"));
    expect(writes).toEqual([{ ...saved, showNames: false }]);
    // The kept app bar drops its names at once; the server renders the next page from the saved row.
    expect(canvas.querySelector(".layout-rail")!.hasAttribute("data-rail-names")).toBe(false);
  } finally {
    dispose();
    fetchSpy.mockRestore();
    dom.cleanup();
  }
});
