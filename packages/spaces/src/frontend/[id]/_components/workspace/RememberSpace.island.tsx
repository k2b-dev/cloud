import { onCleanup, onMount } from "solid-js";
import { setLastSpaceId } from "../settings/SpaceSettingsStore";

/**
 * Records the shown space as the one the Spaces entry opens next. A page counts
 * only while it is visible: a tab opened in the background does not take over,
 * and returning to another tab or window, or going back to a cached page,
 * records that one.
 */
export default function RememberSpace(props: { spaceId: string }) {
  onMount(() => {
    const remember = () => {
      if (document.visibilityState === "visible") setLastSpaceId(props.spaceId);
    };
    remember();
    document.addEventListener("visibilitychange", remember);
    window.addEventListener("pageshow", remember);
    window.addEventListener("focus", remember);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", remember);
      window.removeEventListener("pageshow", remember);
      window.removeEventListener("focus", remember);
    });
  });
  return null;
}
