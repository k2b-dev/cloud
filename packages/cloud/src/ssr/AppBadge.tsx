import { useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import { appBadgeCount } from "./app-badges";
import { railMessages } from "./rail-messages";

/** What a screen reader hears after the app name; empty without a count. Says no more than the "99+" shown. */
export const useAppBadgeDescription = (endpoint: () => string | undefined) => {
  const locale = useLocale();
  return () => {
    const count = appBadgeCount(endpoint());
    const t = railMessages.resolve([locale()]).t;
    return count > 99 ? t.badgeMany : count > 0 ? t.badge({ count }) : "";
  };
};

/**
 * Count on the corner of an app icon. It is positioned over the icon and never
 * takes layout space, so appearing, growing to "99+", or clearing moves
 * nothing. Decorative: the link carries the description.
 */
export function AppBadge(props: { endpoint?: string }) {
  const count = () => appBadgeCount(props.endpoint);
  return (
    <Show when={count() > 0}>
      <span class="cloud-app-badge" aria-hidden="true">
        {count() > 99 ? "99+" : count()}
      </span>
    </Show>
  );
}
