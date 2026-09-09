import { DescriptionList, DetailPanel, IconButtonLink, useLocale } from "@k2b/ui";
import type { SyncDeadLetterEntry } from "@k2b/cloud/services";
import { gatewayOpsMessages } from "../../../messages";
import { syncOpsMessages } from "../ops-messages";

export default function DeadLetterDetail(props: { entry: SyncDeadLetterEntry; closeHref: string }) {
  const locale = useLocale()();
  const { t } = gatewayOpsMessages.resolve([locale]);
  const { t: o } = syncOpsMessages.resolve([locale]);
  return (
    <aside id="sync-dead-letter-detail" class="paper p-3" aria-label={o.details}>
      <DetailPanel>
        <DetailPanel.Header
          title={o.details}
          actions={
            <IconButtonLink href={props.closeHref} label={o.close}>
              <i class="ti ti-x" />
            </IconButtonLink>
          }
        />
        <DetailPanel.Body>
          <DescriptionList
            layout="rows"
            size="sm"
            items={[
              { term: t.syncMessageId, description: <span class="font-mono break-all select-all">{props.entry.messageId}</span> },
              { term: o.tenant, description: <span class="break-all select-all">{props.entry.tenantId}</span> },
              { term: o.consumer, description: props.entry.consumer ?? "—" },
              { term: o.event, description: <span class="break-all select-all">{props.entry.eventId ?? "—"}</span> },
              { term: t.syncAttempts, description: props.entry.attempts },
              { term: t.syncFailedAt, description: props.entry.failedAt },
              { term: t.syncReason, description: props.entry.reason },
            ]}
          />
          {props.entry.error ? (
            <DetailPanel.Section title={t.error}>
              <pre class="whitespace-pre-wrap break-words text-xs select-all">{props.entry.error}</pre>
            </DetailPanel.Section>
          ) : null}
          <DetailPanel.Section title={o.preview}>
            <p class="text-xs text-dimmed">{o.previewBounded}</p>
            <pre class="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs select-all">{props.entry.dataPreview}</pre>
          </DetailPanel.Section>
        </DetailPanel.Body>
      </DetailPanel>
    </aside>
  );
}
