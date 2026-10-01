import { onCleanup, onMount } from "solid-js";
import { setLastGridsPath } from "./GridsSettingsStore";

type Props = {
  path: string;
};

/**
 * Records the shown base page as the one the Grids entry opens next. A page
 * counts only while it is visible: a tab opened in the background does not take
 * over, and returning to another tab or going back to a cached page records that one.
 */
export default function RememberGridsPath(props: Props) {
  onMount(() => {
    const remember = () => {
      if (document.visibilityState === "visible") setLastGridsPath(props.path);
    };
    remember();
    document.addEventListener("visibilitychange", remember);
    window.addEventListener("pageshow", remember);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", remember);
      window.removeEventListener("pageshow", remember);
    });
  });
  return null;
}
