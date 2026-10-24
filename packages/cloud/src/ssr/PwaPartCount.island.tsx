import { AppWorkspace } from "@k2b/ui";
import { onCleanup, onMount, Show } from "solid-js";
import { appBadgeCount, watchAppBadges } from "./app-badges";

export type PwaPartCountProps = {
  /** This part's `pwa.badge` or, without one, its `pwa.summary` route. */
  endpoint: string;
  /** Every count route of the page; the first count on a page reads them all, once a minute like the web's. */
  endpoints: string[];
  /** A badge calls for attention, such as unread messages; a summary's count stays quiet beside the label. */
  attention?: boolean;
};

/** The count of a part in the Cloud app's sidebar and tab bar; nothing at zero. */
export default function PwaPartCount(props: PwaPartCountProps) {
  onMount(() => onCleanup(watchAppBadges(props.endpoints)));
  const count = () => appBadgeCount({ endpoint: props.endpoint });
  return (
    <Show when={props.attention} fallback={<Show when={count() > 0}>{count() > 99 ? "99+" : count()}</Show>}>
      <AppWorkspace.SidebarItemStatus unread={count()} />
    </Show>
  );
}
