import { onMount } from "solid-js";
import { browserNotificationClient } from "../browser/notifications";

export default function BrowserPushRegistration() {
  onMount(() => {
    void browserNotificationClient.refreshExisting().catch((error) => {
      console.warn("[notifications] Failed to refresh the browser endpoint", error);
    });
  });

  return null;
}
