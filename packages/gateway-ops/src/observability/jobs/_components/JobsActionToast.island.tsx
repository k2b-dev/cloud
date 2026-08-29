import { toast, useLocale } from "@k2b/ui";
import { onMount } from "solid-js";
import { gatewayOpsMessages } from "../../../messages";

const ACTION_PARAM = "job_action";
const MESSAGE_PARAM = "job_message";

export default function JobsActionToast() {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  onMount(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get(ACTION_PARAM) !== "accepted") return;

    toast.success(url.searchParams.get(MESSAGE_PARAM) || t.scheduleRunAccepted);
    url.searchParams.delete(ACTION_PARAM);
    url.searchParams.delete(MESSAGE_PARAM);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  });

  return null;
}
