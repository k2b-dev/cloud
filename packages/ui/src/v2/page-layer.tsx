import { createSignal, type JSX, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";

/**
 * Popups that belong to a thing rather than to a place: the context menu of a row, the tip of a button. Rendered
 * beside the thing they would stand inside its structure, a role="menu" in a list and a sibling that turns the thing
 * into "not the last child", which moves edges. Here they stand at the end of the page in a v2 scope of their own,
 * with the theme and the app colour of the thing's scope; the scope has no box (`display: contents`), the popups sit in
 * the top layer. Only once the page is live, so the server and the first render in the browser show the same.
 */
export const PageLayer = (props: { from: () => Element | undefined; children: JSX.Element }) => {
  const [live, setLive] = createSignal(false);
  onMount(() => setLive(true));
  const scope = (layer: HTMLDivElement) => {
    layer.className = "k2-ui";
    layer.style.display = "contents";
    const source = props.from()?.closest(".k2-ui");
    if (!source) return;
    const theme = source.getAttribute("data-theme");
    if (theme) layer.setAttribute("data-theme", theme);
    const app = getComputedStyle(source).getPropertyValue("--k2-app").trim();
    if (app) layer.style.setProperty("--k2-app", app);
  };
  return (
    <Show when={live()}>
      <Portal mount={document.body} ref={scope}>
        {props.children}
      </Portal>
    </Show>
  );
};
