import { onCleanup, onMount, Show } from "solid-js";
import { appBadgeCount, watchAppBadges } from "./app-badges";

export type PwaPartCountProps = {
  /** This part's `pwa.badge` route. */
  endpoint: string;
  /** Every badge route of the sidebar; the first count on a page reads them all, once a minute like the web's. */
  endpoints: string[];
};

/** The count beside a part in the Cloud app's sidebar, such as unread messages; nothing at zero. */
export default function PwaPartCount(props: PwaPartCountProps) {
  onMount(() => onCleanup(watchAppBadges(props.endpoints)));
  const count = () => appBadgeCount({ endpoint: props.endpoint });
  return <Show when={count() > 0}>{count() > 99 ? "99+" : count()}</Show>;
}
