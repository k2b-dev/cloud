import { onCleanup, onMount } from "solid-js";
import { CONTACT_DETAIL_EVENT, getSelectedContactFromUrl } from "./context";

type Props = {
  detailPanelId: string;
};

const hasSelection = (contactId: string | null, bookId: string | null) => Boolean(contactId && bookId);

export const setDesktopDetailVisibility = (panelId: string, open: boolean) => {
  const detailContainer = document.getElementById(`k2b-workspace-detail-${panelId}`);
  if (!detailContainer) return;
  detailContainer.hidden = !open;
};

/**
 * Keeps the responsive detail panel visibility in sync with URL/detail selection state.
 */
export default function DesktopDetailLayoutSync(props: Props) {
  let addressContactKey: string | null = null;
  const syncFromUrl = () => {
    const selected = getSelectedContactFromUrl();
    setDesktopDetailVisibility(props.detailPanelId, hasSelection(selected.contactId, selected.bookId));
    const panel = document.getElementById(`k2b-workspace-detail-${props.detailPanelId}`);
    const contactKey = hasSelection(selected.contactId, selected.bookId) ? `${selected.bookId}:${selected.contactId}` : null;
    if (selected.addressId) addressContactKey = contactKey;
    else if (contactKey !== addressContactKey) addressContactKey = null;
    // Keep the destination visible when returning from a deep-linked editor at tablet widths.
    panel?.toggleAttribute("data-contacts-address-context", addressContactKey !== null);
    if (selected.addressId) panel?.setAttribute("data-workspace-detail-phone", "page");
    else panel?.removeAttribute("data-workspace-detail-phone");
  };

  onMount(() => {
    const handleDetailSelect = () => {
      syncFromUrl();
    };

    const handlePopState = () => syncFromUrl();

    syncFromUrl();
    window.addEventListener(CONTACT_DETAIL_EVENT, handleDetailSelect);
    window.addEventListener("popstate", handlePopState);

    onCleanup(() => {
      window.removeEventListener(CONTACT_DETAIL_EVENT, handleDetailSelect);
      window.removeEventListener("popstate", handlePopState);
    });
  });

  return null;
}
