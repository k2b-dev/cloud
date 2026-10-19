import { markHintSeen } from "@k2b/cloud/browser/hints";
import { MovedHint, ViewTabs } from "@k2b/ui";
import { createSignal, onCleanup, onMount } from "solid-js";
import { useSpaceMessages } from "../../messages";
import type { ViewType } from "../settings/SpaceSettingsStore";
import { SPACES_DETAIL_NAVIGATION_EVENT, type SpacesDetailNavigation } from "./workspace-events";

export default function SpaceViewTabs(props: { spaceId: string; query: string; currentView: ViewType; hintOpen?: boolean }) {
  const t = useSpaceMessages();
  const [query, setQuery] = createSignal(props.query);
  const [hint, setHint] = createSignal(Boolean(props.hintOpen));
  let target: HTMLDivElement | undefined;
  const path = `/app/spaces/${props.spaceId}`;
  const seen = () => {
    markHintSeen("spaces.view-tabs");
    setHint(false);
  };
  onMount(() => {
    const onTabClick = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      if (anchor && items().some((item) => item.href === anchor.getAttribute("href"))) seen();
    };
    document.addEventListener("click", onTabClick, true);
    onCleanup(() => document.removeEventListener("click", onTabClick, true));
    if (window.location.pathname === path) setQuery(window.location.search);
    const onCommitted = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: SpacesDetailNavigation = event.detail;
      if (detail.history !== "none") return;
      const url = new URL(detail.href, window.location.origin);
      if (url.pathname === path) setQuery(url.search);
    };
    window.addEventListener(SPACES_DETAIL_NAVIGATION_EVENT, onCommitted);
    onCleanup(() => window.removeEventListener(SPACES_DETAIL_NAVIGATION_EVENT, onCommitted));
  });
  const href = (view: ViewType) => {
    const params = new URLSearchParams(query());
    params.set("view", view);
    return `${path}?${params}`;
  };
  const items = () => [
    { id: "list", label: t.list, icon: "ti ti-layout-list", href: href("list") },
    { id: "table", label: t.table, icon: "ti ti-table", href: href("table") },
    { id: "kanban", label: t.kanban, icon: "ti ti-layout-kanban", href: href("kanban") },
    { id: "calendar", label: t.calendar, icon: "ti ti-calendar", href: href("calendar") },
  ];
  return (
    <div ref={target} data-spaces-view-tabs>
      <ViewTabs label={t.headViews} items={items()} current={props.currentView} />
      <MovedHint
        open={hint()}
        target={() => target?.querySelector<HTMLAnchorElement>('[aria-current="page"]') ?? undefined}
        onDismiss={seen}
        action={{ label: t.headShowViews, onClick: () => target?.querySelector<HTMLAnchorElement>('[aria-current="page"]')?.focus() }}
      >
        {t.headViewsHint}
      </MovedHint>
    </div>
  );
}
