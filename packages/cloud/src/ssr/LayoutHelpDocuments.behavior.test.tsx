import { expect, test } from "bun:test";
import { createSignal, Show } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { HelpDocumentManifest } from "../shared/help";

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("help documents leave a closing non-keyed Show without reading their props again", async () => {
    const dom = createDomTestHarness();
    const { LayoutHelpDocuments } = await import("./LayoutHelp");
    const document: HelpDocumentManifest = {
      id: "inventory-start",
      title: "Start",
      order: 1,
      searchUrl: "/api/help/search",
      url: "/api/help/start",
    };
    const [help, setHelp] = createSignal<{ pageBase: string; documents: HelpDocumentManifest[] }>();
    setHelp({ pageBase: "/app/inventory/help", documents: [document] });
    const dispose = render(
      () => <Show when={help()}>{(current) => <LayoutHelpDocuments pageBase={current().pageBase} documents={current().documents} />}</Show>,
      dom.root,
    );
    try {
      expect(window.__cloudLayoutHelpPageBase).toBe("/app/inventory/help");
      expect(window.__cloudLayoutHelpTopics?.has("inventory-start")).toBe(true);
      // The Show's accessor throws once its condition is false, which is exactly when the documents unregister.
      expect(() => setHelp(undefined)).not.toThrow();
      expect(window.__cloudLayoutHelpPageBase).toBeUndefined();
      expect(window.__cloudLayoutHelpTopics?.has("inventory-start")).toBe(false);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}
