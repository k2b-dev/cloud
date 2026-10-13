import { createEffect, createSignal, createUniqueId, For, type JSX, onCleanup, Show, untrack } from "solid-js";
import type { MaybeAccessor } from "../inputs/field-contract";
import { resolveMaybeAccessor } from "../inputs/field-contract";
import { assertStableUiId } from "./stable-id";
import { useTableOfContentsMessages } from "./table-of-contents-messages";

export type TableOfContentsItem = { id: string; label: string };
export type TableOfContentsProps = {
  items: readonly TableOfContentsItem[];
  /** Visible heading and navigation name. Defaults to the localized "On this page". */
  title?: string;
  /** Element whose scrolling decides the active section. Defaults to the window. */
  scrollRoot?: MaybeAccessor<HTMLElement | undefined>;
  /** Stay in view inside the caller's layout. */
  sticky?: boolean;
  /** Called when another section becomes active. */
  onActiveChange?: (id: string | undefined) => void;
  class?: string;
};

/**
 * Native section links with a scroll spy on the window or a content container.
 * @example <TableOfContents items={[{ id: "sharing", label: "Sharing" }]} sticky />
 */
export function TableOfContents(props: TableOfContentsProps): JSX.Element {
  const t = useTableOfContentsMessages();
  const headingId = assertStableUiId(`k2b-toc-${createUniqueId().replace(/[^a-zA-Z0-9_-]/g, "-")}`, "TableOfContents heading id");
  const [active, setActive] = createSignal(props.items[0]?.id);
  createEffect(() => {
    // Reading every id here makes a changed id or a store update recompute the active section.
    const ids = props.items.map((item) => item.id);
    const root = resolveMaybeAccessor(props.scrollRoot);
    const target = root ?? window;
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      const box = root?.getBoundingClientRect();
      const top = box ? box.top + (root?.clientTop ?? 0) : 0;
      const height = root?.clientHeight ?? window.innerHeight;
      const line = top + height / 4;
      const headings = ids.map((id) => ({ id, box: document.getElementById(id)?.getBoundingClientRect() }));
      let next = ids[0];
      for (const heading of headings) if (heading.box && heading.box.top <= line) next = heading.id;
      const last = headings.at(-1);
      const atEnd = root
        ? root.scrollHeight - root.clientHeight - root.scrollTop <= 4
        : document.documentElement.scrollHeight - window.innerHeight - window.scrollY <= 4;
      if (atEnd && last?.box && last.box.top < top + height && last.box.bottom > top) next = last.id;
      if (next !== active()) {
        setActive(next);
        props.onActiveChange?.(next);
      }
    };
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(update);
    };
    target.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    untrack(update);
    onCleanup(() => {
      target.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame !== undefined) cancelAnimationFrame(frame);
    });
  });
  return (
    <Show when={props.items.length > 0}>
      <nav
        class={`k2b-toc${props.class ? ` ${props.class}` : ""}`}
        data-sticky={props.sticky ? "true" : undefined}
        aria-labelledby={headingId}
      >
        <p class="k2b-toc__title" id={headingId}>
          {props.title ?? t().title}
        </p>
        <ol class="k2b-toc__list">
          <For each={props.items}>
            {(item) => (
              <li>
                <a class="k2b-toc__link" href={`#${item.id}`} aria-current={active() === item.id ? "location" : undefined}>
                  {item.label}
                </a>
              </li>
            )}
          </For>
        </ol>
      </nav>
    </Show>
  );
}
export default TableOfContents;
