import { formatDateTime } from "@k2b/cloud/shared";
import { Button, InlineGuidance, prompts, toast, useLocale } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { apiClient } from "../../api/client";
import {
  type HealthApp,
  type HealthWebhook,
  type HealthWebhookInput,
  readHealthWebhookResponse,
  responseErrorMessage,
} from "../../frontend/health-webhook-queries";
import { toInput, WebhookFields } from "../../frontend/webhook-editor";
import { gatewayOpsMessages } from "../../messages";
import { areaMessages } from "../_components/area-messages";
import { createDraftForm, SaveRejected } from "../_components/draft-form";
import { SaveOutcome } from "../_components/SaveOutcome";

/** One alert in the detail column: its fields save with the button in the level head; test and delete act at once. */
export default function WebhookDetail(props: { webhook: HealthWebhook; apps: HealthApp[]; timeZone: string }) {
  const locale = useLocale();
  const t = () => areaMessages.resolve([locale()]).t;
  const g = () => gatewayOpsMessages.resolve([locale()]).t;
  const [testing, setTesting] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const form = createDraftForm<HealthWebhookInput>({
    initial: toInput(props.webhook),
    locale,
    validate: (value): Record<string, string> => ({
      ...(value.name.trim() ? {} : { name: g().webhookNameDescription }),
      ...(value.url.trim() ? {} : { url: g().urlDescription }),
    }),
    save: async (value) => {
      const response = await apiClient.health.webhooks[":id"].$put({ param: { id: props.webhook.id }, json: value });
      if (!response.ok) throw new SaveRejected(await responseErrorMessage(response, g().saveWebhookFailed));
      return toInput(await readHealthWebhookResponse(response, g().unexpectedWebhookResponse));
    },
  });

  const test = async () => {
    if (testing()) return;
    setTesting(true);
    try {
      const response = await apiClient.health.webhooks[":id"].test.$post({ param: { id: props.webhook.id } });
      if (!response.ok) throw new Error(await responseErrorMessage(response, g().testWebhookFailed));
      toast.success(g().webhookTestSubmitted);
    } catch (error) {
      void prompts.error(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    if (deleting()) return;
    const confirmed = await prompts.confirm(g().deleteWebhookConfirm({ name: props.webhook.name }), {
      title: g().deleteWebhookTitle,
      variant: "danger",
    });
    if (confirmed !== true) return;
    setDeleting(true);
    try {
      const response = await apiClient.health.webhooks[":id"].$delete({ param: { id: props.webhook.id } });
      if (!response.ok) throw new Error(await responseErrorMessage(response, g().deleteWebhookFailed));
      window.location.assign("/admin/observability/alerts");
    } catch (error) {
      setDeleting(false);
      void prompts.error(error instanceof Error ? error.message : String(error));
    }
  };

  const lastSent = () =>
    props.webhook.lastSentAt
      ? t().lastTest({
          when: formatDateTime(props.webhook.lastSentAt, { locale: locale(), timeZone: props.timeZone }),
          status: props.webhook.lastError ? g().error : g().ok,
        })
      : t().neverSent;

  return (
    <div class="flex max-w-2xl flex-col gap-5 px-[var(--ui-space-shell)] pb-[var(--ui-space-shell)]">
      <SaveOutcome t={t()} outcome={form.outcome()} onRetry={() => void form.save()} />
      <Show when={props.webhook.lastError}>
        {(error) => (
          <InlineGuidance tone="danger" icon="ti ti-alert-triangle">
            {error()}
          </InlineGuidance>
        )}
      </Show>
      <WebhookFields data={form.draft} update={form.update} apps={props.apps} />
      <div class="flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" size="sm" loading={testing()} onClick={() => void test()} disabled={form.saving()}>
          <i class="ti ti-plug" aria-hidden="true" />
          {g().test}
        </Button>
        <span class="text-xs text-dimmed">{lastSent()}</span>
      </div>
      <section class="flex flex-col gap-2 pt-2">
        <h3 class="text-sm font-semibold text-primary">{t().dangerZone}</h3>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <p class="text-xs text-dimmed">{t().deleteAlertHelp}</p>
          <Button type="button" variant="danger" size="sm" loading={deleting()} onClick={() => void remove()}>
            <i class="ti ti-trash" aria-hidden="true" />
            {t().deleteAlert}
          </Button>
        </div>
      </section>
    </div>
  );
}
