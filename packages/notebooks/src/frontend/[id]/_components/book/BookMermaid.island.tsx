import { mermaidConfig } from "@k2b/cloud/browser/mermaid";
import { useLocale } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { enhanceBookMermaid } from "./book-mermaid";
import { BOOK_CONTENT_EVENT } from "./book-state";
import { bookMessages } from "./messages";

/** Optional enhancement: the article is complete and readable without this island. */
export default function BookMermaid(props: { rootId: string }) {
  const locale = useLocale();
  onMount(() => {
    let currentController: AbortController | undefined;
    const render = async () => {
      currentController?.abort();
      const controller = new AbortController();
      currentController = controller;
      const root = document.getElementById(props.rootId);
      if (!root?.querySelector(".notebook-book-mermaid")) return;
      const errorText = bookMessages.resolve([locale()]).t.diagramError;
      const mermaid = await import("mermaid").then((module) => module.default).catch(() => null);
      if (controller.signal.aborted || !root.isConnected) return;
      if (!mermaid) {
        await enhanceBookMermaid(
          root,
          async () => {
            throw new Error("Diagram renderer unavailable");
          },
          controller.signal,
          errorText,
        );
        return;
      }
      // SVG images cannot render HTML labels.
      mermaid.initialize({ ...mermaidConfig({ dark: document.documentElement.classList.contains("dark") }), htmlLabels: false });
      await enhanceBookMermaid(
        root,
        async (source, id) => {
          const scratch = document.createElement("div");
          scratch.style.position = "absolute";
          scratch.style.left = "-100000px";
          scratch.setAttribute("aria-hidden", "true");
          document.body.append(scratch);
          const remove = () => scratch.remove();
          controller.signal.addEventListener("abort", remove, { once: true });
          try {
            return (await mermaid.render(id, source, scratch)).svg;
          } finally {
            controller.signal.removeEventListener("abort", remove);
            remove();
          }
        },
        controller.signal,
        errorText,
      );
    };
    void render();
    window.addEventListener(BOOK_CONTENT_EVENT, render);
    onCleanup(() => {
      currentController?.abort();
      window.removeEventListener(BOOK_CONTENT_EVENT, render);
    });
  });
  return null;
}
