import { createEffect, onCleanup, onMount } from "solid-js";
import { useAiChatActions } from "./message-actions";

export function AssistantMarkdownBlock(props: { html: string }) {
  const actions = useAiChatActions();
  let element!: HTMLDivElement;
  const originals = new WeakMap<HTMLAnchorElement, { href: string; target: string | null }>();
  const files = new WeakMap<HTMLAnchorElement, string>();
  createEffect(() => {
    props.html;
    for (const link of Array.from(element.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
      const original = originals.get(link) ?? { href: link.getAttribute("href")!, target: link.getAttribute("target") };
      originals.set(link, original);
      const file = actions.resolveFileLink?.(original.href);
      link.setAttribute("href", file?.href ?? original.href);
      const target = file ? null : original.target;
      if (target) link.setAttribute("target", target);
      else link.removeAttribute("target");
      if (file) files.set(link, file.path);
      else files.delete(link);
    }
  });
  onMount(() => {
    const handleClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !actions.onOpenFile
      )
        return;
      const link = event.target instanceof Element ? event.target.closest("a") : null;
      const path = link ? files.get(link) : undefined;
      if (!path) return;
      event.preventDefault();
      actions.onOpenFile(path);
    };
    element.addEventListener("click", handleClick);
    onCleanup(() => element.removeEventListener("click", handleClick));
  });
  return <div ref={element} class="assistant-markdown-block" innerHTML={props.html} />;
}
