import { apiClient } from "@k2b/cloud/clients/core";
import { mutation } from "@k2b/stdlib/solid";
import { Button, InlineGuidance, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import { appDetailsMessages } from "./messages";

/** Queues one failed delivery again, keeping its event ID; the reloaded page shows the new state. */
export default function Redeliver(props: { id: string; label: string }) {
  const locale = useLocale();
  const t = () => appDetailsMessages.resolve([locale()]).t;
  const redeliver = mutation.create({
    mutation: async (_: void, { abortSignal }) => {
      const response = await apiClient["app-events"].deliveries[":id"].redeliver
        .$post({ param: { id: props.id } }, { init: { signal: abortSignal } })
        // A lost connection is the same recoverable failure as a server error, in the person's language.
        .catch(() => null);
      if (response?.status === 409) throw new Error(t().notRedeliverable);
      if (!response?.ok) throw new Error(t().redeliverFailed);
    },
    onSuccess: () => window.location.reload(),
  });
  return (
    <span class="flex flex-wrap items-center gap-2">
      <Button size="xs" variant="secondary" aria-label={props.label} loading={redeliver.loading()} onClick={() => void redeliver.mutate()}>
        {t().redeliver}
      </Button>
      <Show when={redeliver.error()}>
        {(error) => (
          <InlineGuidance role="alert" tone="danger">
            {error().message}
          </InlineGuidance>
        )}
      </Show>
    </span>
  );
}
