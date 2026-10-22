import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { PanelRequest } from "../browser/panel";
import type { PanelState } from "../browser/panel-context-bridge";
import type { HelpDocumentManifest } from "../shared/help";
import { helpArticlePartsServer } from "./layout-help-article.server";
import { formatHelpDocumentMarkdown } from "./layout-help-markdown";

const documents: HelpDocumentManifest[] = ["first", "second"].map((id) => ({
  id,
  title: `Article ${id}`,
  order: 1,
  url: `/api/help/${id}`,
  searchUrl: "/api/help/search",
}));
const until = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error("Help did not reach the expected state");
};

if (isServer) test.skip("requires browser conditions", () => {});
else {
  const setup = async () => {
    const dom = createDomTestHarness();
    const help = await import("./LayoutHelp");
    const { default: Trigger } = await import("./LayoutHelpTrigger");
    const { default: ShellRuntime } = await import("./ShellRuntime.island");
    const { prompts } = await import("@k2b/ui");
    const dialog = spyOn(prompts, "dialog").mockImplementation(async () => undefined);
    return {
      dom,
      help,
      Trigger,
      ShellRuntime,
      dialog,
      cleanup: () => {
        dialog.mockRestore();
        dom.cleanup();
      },
    };
  };

  for (const variant of ["rail", "header"] as const)
    test(`${variant} Help toggles only its provider and follows slot aria state`, async () => {
      const fixture = await setup();
      const { dom, Trigger, dialog } = fixture;
      const requests: PanelRequest[] = [];
      let accepted = true;
      const request = (event: CustomEvent<PanelRequest>) => {
        requests.push({ ...event.detail });
        if (event.detail.action === "open") event.detail.accepted = accepted;
      };
      window.addEventListener("cloud.panel.request", request);
      const dispose = render(() => createComponent(Trigger, { variant, panel: true, helpOpen: false }), dom.root);
      const button = dom.root.querySelector<HTMLButtonElement>("button")!;
      const state = (provider: string, open: boolean) =>
        window.dispatchEvent(
          new CustomEvent<PanelState>("cloud.panel.state", {
            detail: { provider, open, appName: "Fixture", consent: false, allowed: true, saving: false },
          }),
        );
      try {
        expect(button.getAttribute("aria-controls")).toBe("cloud-panel");
        expect(button.getAttribute("aria-expanded")).toBe("false");
        button.click();
        expect(requests.at(-1)).toMatchObject({ action: "open", provider: "core" });
        state("core", true);
        expect(button.getAttribute("aria-expanded")).toBe("true");
        button.click();
        expect(requests.at(-1)).toEqual({ action: "close" });
        state("other", true);
        expect(button.getAttribute("aria-expanded")).toBe("false");
        button.click();
        expect(requests.at(-1)).toMatchObject({ action: "open", provider: "core" });
        expect(dialog).not.toHaveBeenCalled();
        accepted = false;
        state("core", false);
        button.click();
        await until(() => dialog.mock.calls.length === 1);
      } finally {
        dispose();
        window.removeEventListener("cloud.panel.request", request);
        fixture.cleanup();
      }
    });

  test("Help's public opener and cloud.help open core and fall back only when unaccepted", async () => {
    const fixture = await setup();
    const { dom, help, ShellRuntime, Trigger, dialog } = fixture;
    dom.document.cookie = `cloud.timezone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}; Path=/`;
    const { collectContextAwareCommands } = await import("../browser/command-bridge");
    const { runContextAwareCommand } = await import("../browser/commands");
    let accepted = true;
    const requests: PanelRequest[] = [];
    const request = (event: CustomEvent<PanelRequest>) => {
      requests.push({ ...event.detail });
      if (event.detail.action === "open") event.detail.accepted = accepted;
    };
    window.addEventListener("cloud.panel.request", request);
    const dispose = render(
      () => (
        <>
          <ShellRuntime commands={{ searchResources: false }} />
          <Trigger variant="rail" />
        </>
      ),
      dom.root,
    );
    try {
      expect(dom.root.querySelector("button")?.hasAttribute("aria-expanded")).toBe(false);
      const command = collectContextAwareCommands().find((command) => command.id === "cloud.help");
      if (!command) throw new Error("Missing cloud.help");
      help.openLayoutHelpDialog();
      await runContextAwareCommand(command);
      expect(requests).toHaveLength(2);
      for (const entry of requests) expect(entry).toMatchObject({ action: "open", provider: "core" });
      expect(dialog).not.toHaveBeenCalled();
      accepted = false;
      help.openLayoutHelpDialog();
      expect(dialog).toHaveBeenCalledTimes(1);
      await runContextAwareCommand(command);
      expect(dialog).toHaveBeenCalledTimes(2);
    } finally {
      dispose();
      window.removeEventListener("cloud.panel.request", request);
      fixture.cleanup();
    }
  });

  test("a seeded page article copies Markdown and reopens from cache without fetching", async () => {
    const fixture = await setup();
    const { dom, help } = fixture;
    const payload = {
      id: "first",
      title: "Article first",
      locale: "en",
      kind: "task" as const,
      needs: "edit" as const,
      markdown: "Seeded **Markdown**.\n\n## Steps\n\n1. Open sharing.",
      related: [],
    };
    const html =
      '<p>Seeded <strong>lead</strong>.</p><h2 id="steps">Steps</h2><div class="help-steps"><ol><li>Open sharing.</li></ol></div>';
    const initialArticle = { payload, parts: helpArticlePartsServer(html) };
    const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Seeded articles must not fetch"));
    const write = spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const seededProps = { documents, initialTopic: "first", initialArticle };
    const dispose = render(() => <help.LayoutHelpPage {...seededProps} />, dom.root);
    const articleFrame = () => {
      const head = document.createElement("header");
      head.innerHTML = dom.root.querySelector(".help-article-head")!.innerHTML;
      // Reopening remounts controls with new dropdown/tooltip IDs; compare the article head content.
      head.querySelector(".help-article-tools")?.remove();
      return {
        documents: [...dom.root.querySelectorAll(".help-document")].map((element) => element.innerHTML),
        head: head.innerHTML,
      };
    };
    const articleSettled = () => !!dom.root.querySelector('[role="menuitemradio"][aria-checked="true"]');
    try {
      // The selected section proves the settle effect ran with the rebuilt payload HTML.
      await until(articleSettled);
      expect(dom.root.querySelector(".help-article-lead")?.textContent).toBe("Seeded lead.");
      const copy = dom.root.querySelector(".help-article-head .ti-markdown")!.closest("button")!;
      copy.click();
      // Clipboard writes must begin in the click's user activation, without awaiting a fetch.
      expect(write).toHaveBeenCalledWith(formatHelpDocumentMarkdown(payload));
      expect(fetch).not.toHaveBeenCalled();
      await until(() => dom.root.querySelector("[data-help-menu]")?.getAttribute("aria-expanded") !== "true");
      const before = articleFrame();
      dom.root.querySelector<HTMLButtonElement>(".help-head-back")!.click();
      await until(() => !!dom.root.querySelector('[data-help-topic="first"]'));
      expect(dom.root.querySelector(".help-article-head")).toBeNull();
      dom.root.querySelector<HTMLButtonElement>('[data-help-topic="first"]')!.click();
      // The selected section proves the settle effect ran with the rebuilt payload HTML.
      await until(articleSettled);
      expect(articleFrame()).toEqual(before);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      dispose();
      write.mockRestore();
      fetch.mockRestore();
      fixture.cleanup();
    }
  });
}
