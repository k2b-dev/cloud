import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

const dom = isServer ? undefined : createDomTestHarness();
const reload = isServer ? undefined : await import("@k2b/cloud/browser/reload");
const views = isServer ? undefined : await import("./code-deferred-views");
const ui = isServer ? undefined : await import("@k2b/ui");
const fixture = isServer ? undefined : await import("@k2b/cloud/ssr/code-page/code-page.fixture");
let dispose = () => {};
afterEach(() => {
  dispose();
  mock.restore();
});
process.once("exit", () => dom?.cleanup());

if (isServer) test.skip("requires browser conditions", () => {});
else {
  // The seed a direct load of /app/assistant/code/c_woche1 carries from the server.
  const seed = () => ({
    ...fixture!.codePageFixture("overview", "en"),
    owner: { kind: "person" as const, ref: null, title: "Weekly sales report", typeTitle: null },
    href: "/app/assistant/code/c_woche1",
  });
  const mount = () => {
    const host = document.createElement("div");
    document.body.append(host);
    delegateEvents(["click"]);
    const data = seed();
    const stop = render(
      () =>
        createComponent(ui!.LocaleProvider, {
          locale: "en",
          get children() {
            return createComponent(views!.AssistantCodeDetail, { data });
          },
        }),
      host,
    );
    dispose = () => {
      stop();
      host.remove();
    };
    return host;
  };
  const settle = () => Bun.sleep(0);
  const heading = (host: HTMLElement) => host.querySelector("h1")?.textContent?.trim();

  test("a Code detail shows the loading surface first, then the shared Code page with its SSR seed", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    spyOn(reload!, "importOnDemand").mockImplementation(async (loader) => {
      await pending;
      return loader();
    });
    const host = mount();
    const status = host.querySelector('[role="status"]');
    expect(status?.textContent).toContain("Loading…");
    expect(host.querySelector(".cloud-code")).toBeNull();
    release();
    // The shared Code page is a separate chunk; give its import a moment.
    for (let i = 0; i < 50 && !host.querySelector(".cloud-code"); i++) await Bun.sleep(10);
    expect(heading(host)).toBe("Weekly sales report");
    expect(host.textContent).toContain("Your Code · runs as you");
    expect(host.querySelector(".assistant-deferred-feedback")).toBeNull();
  });

  test("a failed download shows the error with Retry, and Retry loads the same Code page", async () => {
    const load = spyOn(reload!, "importOnDemand")
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async (loader) => loader());
    const host = mount();
    await settle();
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("This view could not be loaded. Your apps and automations keep running.");
    const retry = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Try again");
    expect(retry).toBeDefined();
    retry!.click();
    for (let i = 0; i < 50 && !host.querySelector(".cloud-code"); i++) await Bun.sleep(10);
    expect(heading(host)).toBe("Weekly sales report");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("leaving during the download never creates the late Code page", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loaded = mock(() => {});
    spyOn(reload!, "importOnDemand").mockImplementation(async (loader) => {
      await pending;
      const component = await loader();
      loaded();
      return component;
    });
    const host = mount();
    dispose();
    release();
    for (let i = 0; i < 50 && loaded.mock.calls.length === 0; i++) await Bun.sleep(10);
    expect(loaded).toHaveBeenCalled();
    expect(host.querySelector(".cloud-code")).toBeNull();
  });
}
