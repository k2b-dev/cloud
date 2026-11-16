import { spyOn } from "bun:test";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { HelpDocumentManifest } from "../shared/help";

const documents: HelpDocumentManifest[] = [
  { id: "first", title: "Article first", order: 0, url: "/api/help/first", searchUrl: "/api/help/search" },
];

/** Opens Help on a 390 px phone without the panel, as an app without a panel slot does. */
export const openPhoneHelp = async () => {
  const dom = createDomTestHarness();
  dom.window.happyDOM.setWindowSize({ width: 390, height: 844 });
  const previousMatchMedia = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
  Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: dom.window.matchMedia.bind(dom.window) });
  const { openLayoutHelpDialog } = await import("./LayoutHelp");
  const { dialogCore } = await import("@k2b/ui");
  const { LayoutHelpDocuments } = await import("./layout-help-registry");
  const { ShellDataProvider } = await import("./shell-data");
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () =>
        Response.json({ id: "first", locale: "en", title: "Article first", markdown: "Steps", html: "<p>Steps</p>", kind: "task" }),
      { preconnect: () => {} },
    ),
  );
  const dispose = render(
    () => (
      <ShellDataProvider data={{ apps: [], legalLinks: [], searchLinks: {}, theme: "light", appId: "spaces", accent: "#16a34a" }}>
        <LayoutHelpDocuments documents={documents} pageBase="/app/spaces/help" />
      </ShellDataProvider>
    ),
    dom.root,
  );
  openLayoutHelpDialog();
  return {
    dom,
    dialogCore,
    cleanup: async () => {
      dialogCore.close();
      await Bun.sleep(20);
      dispose();
      fetch.mockRestore();
      if (previousMatchMedia) Object.defineProperty(globalThis, "matchMedia", previousMatchMedia);
      else Reflect.deleteProperty(globalThis, "matchMedia");
      dom.cleanup();
    },
  };
};

export const until = async (condition: () => unknown) => {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++) await Bun.sleep(10);
};
