import { onSettled } from "solid-js";
import { installOverlayScrollbars } from "@k2b/ui/v2";

/** Drives the server-rendered overlay scrollbars. Renders nothing. */
export default function ShellBehaviour() {
  // Solid 2: onSettled replaces onMount and may return its cleanup.
  onSettled(() => installOverlayScrollbars(document));
  return null;
}
