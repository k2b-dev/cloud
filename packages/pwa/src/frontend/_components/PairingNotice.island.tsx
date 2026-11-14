import { useLocale } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { shellMessages } from "../../messages";
import { watchPairingLink } from "../phone";

/**
 * Takes a pairing link out of the address on pages that do not pair. A connected app (`name` set) explains why it does
 * not pair again; elsewhere the link is dropped.
 */
export default function PairingNotice(props: { name?: string }) {
  const locale = useLocale();
  const t = () => shellMessages.resolve([locale()]).t;
  onMount(() => {
    onCleanup(
      watchPairingLink(() => {
        if (!props.name) return;
        const text = t().alreadyConnected({ name: props.name });
        // Rare on a page: the toast code loads only when a connected app sees a pairing link, so it stays out of the island.
        void import("@k2b/ui").then(({ toast }) => toast(text, { iconClass: "ti ti-info-circle" }));
      }),
    );
  });
  return null;
}
