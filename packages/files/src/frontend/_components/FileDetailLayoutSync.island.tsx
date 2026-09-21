import { onCleanup, onMount } from "solid-js";
import { DETAIL_FILE_SELECT_EVENT, type DetailFileSelectPayload, getDetailFileFromUrl } from "./context";

type Props = {
  detailContainerId: string;
};

const setDetailVisibility = (containerId: string, open: boolean) => {
  const detailContainer = document.getElementById(containerId);
  if (!detailContainer) return;

  if (open) {
    detailContainer.classList.remove("hidden");
    detailContainer.classList.add("flex");
    return;
  }

  detailContainer.classList.add("hidden");
  detailContainer.classList.remove("flex");
};

export default function FileDetailLayoutSync(props: Props) {
  const syncFromUrl = () => {
    setDetailVisibility(props.detailContainerId, Boolean(getDetailFileFromUrl()));
  };

  onMount(() => {
    const handleDetailSelect = (event: Event) => {
      const payload = (event as CustomEvent<DetailFileSelectPayload>).detail;
      setDetailVisibility(props.detailContainerId, Boolean(payload.itemKey));
    };

    const handlePopState = () => syncFromUrl();

    syncFromUrl();
    window.addEventListener(DETAIL_FILE_SELECT_EVENT, handleDetailSelect);
    window.addEventListener("popstate", handlePopState);

    onCleanup(() => {
      window.removeEventListener(DETAIL_FILE_SELECT_EVENT, handleDetailSelect);
      window.removeEventListener("popstate", handlePopState);
    });
  });

  return null;
}
