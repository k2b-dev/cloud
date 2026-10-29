import { IconButton, useLocale } from "@k2b/ui";
import type { HealthApp } from "../../frontend/health-webhook-queries";
import { openWebhookEditor } from "../../frontend/webhook-editor";
import { areaMessages } from "../_components/area-messages";

/** Adding an alert stays a dialog. The new alert then opens in the detail column. */
export default function AddWebhookButton(props: { apps: HealthApp[]; variant?: "icon" | "button" }) {
  const locale = useLocale();
  const t = () => areaMessages.resolve([locale()]).t;
  const open = () =>
    void openWebhookEditor(undefined, props.apps, async (saved) => {
      window.location.assign(saved ? `/admin/observability/alerts?webhook=${encodeURIComponent(saved.id)}` : "/admin/observability/alerts");
    });
  return props.variant === "button" ? (
    <button type="button" class="k2b-button" data-size="sm" data-variant="primary" onClick={open}>
      <span class="k2b-button__label">
        <i class="ti ti-plus" aria-hidden="true" />
        {t().addWebhook}
      </span>
    </button>
  ) : (
    <IconButton label={t().addWebhook} size="sm" variant="ghost" onClick={open}>
      <i class="ti ti-plus" aria-hidden="true" />
    </IconButton>
  );
}
