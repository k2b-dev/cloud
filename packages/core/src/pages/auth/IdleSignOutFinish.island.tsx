import { finishIdleSignOut } from "@k2b/cloud/browser/session";
import { onMount } from "solid-js";

/** After a shared workstation signed out for lack of input: ends the session the page left and clears its data here. */
export default function IdleSignOutFinish() {
  onMount(() => void finishIdleSignOut());
  return null;
}
