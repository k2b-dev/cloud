import {
  DescriptionList,
  DetailPanel,
  IconButtonLink,
  isStructuredDataValue,
  Placeholder,
  StructuredDataPreview,
  type StructuredDataValue,
  useLocale,
} from "@k2b/ui";
import type { TraceEvent, TraceSpan } from "@valentinkolb/cloud/services";
import { formatDate, formatDurationMs, formatNumber } from "@valentinkolb/cloud/shared";
import type { JSX } from "solid-js";
import { gatewayOpsMessages } from "../../../messages";

const traceData = (value: Record<string, unknown>, error: string): StructuredDataValue =>
  isStructuredDataValue(value) ? value : { error };

export type RunDetailPanelProps = {
  span: TraceSpan;
  events: TraceEvent[];
  status: JSX.Element;
  closeHref: string;
};

export default function RunDetailPanel(props: RunDetailPanelProps) {
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
  return (
    <aside class="paper min-h-0 p-3" aria-label={t.runDetail}>
      <DetailPanel>
        <DetailPanel.Header
          icon="ti ti-activity"
          title={props.span.name}
          subtitle={props.span.spanKey ?? props.span.spanId}
          actions={
            <IconButtonLink href={props.closeHref} size="sm" label={t.closeRunDetail}>
              <i class="ti ti-x" aria-hidden="true" />
            </IconButtonLink>
          }
        />

        <DetailPanel.Body>
          <DetailPanel.Summary title={t.status}>
            <DescriptionList
              layout="rows"
              size="sm"
              items={[
                {
                  term: t.source,
                  description: <span class="break-all font-mono">{props.span.source}</span>,
                },
                { term: t.type, description: props.span.category },
                { term: t.status, description: props.status },
                { term: t.started, description: formatDate(props.span.startedAt, { locale: locale() }) },
                { term: t.ended, description: formatDate(props.span.endedAt, { locale: locale() }) },
                { term: t.duration, description: formatDurationMs(props.span.durationMs, { locale: locale() }) },
                { term: t.events, description: formatNumber(props.span.eventCount, { locale: locale() }) },
                ...(props.span.statusMessage
                  ? [
                      {
                        term: t.message,
                        description: <span class="break-words">{props.span.statusMessage}</span>,
                      },
                    ]
                  : []),
              ]}
            />
          </DetailPanel.Summary>

          {props.span.summary || props.span.attributes ? (
            <DetailPanel.Group label={t.runData}>
              {props.span.summary ? (
                <DetailPanel.Section title={t.summary} icon="ti ti-list-details" tone="accent">
                  <StructuredDataPreview data={traceData(props.span.summary, t.invalidTraceData)} maxRows={8} />
                </DetailPanel.Section>
              ) : null}
              {props.span.attributes ? (
                <DetailPanel.Section title={t.attributes} icon="ti ti-braces" tone="neutral">
                  <StructuredDataPreview data={traceData(props.span.attributes, t.invalidTraceData)} maxRows={10} />
                </DetailPanel.Section>
              ) : null}
            </DetailPanel.Group>
          ) : null}

          <DetailPanel.Section title={t.events} icon="ti ti-list" tone="neutral">
            {props.events.length === 0 ? (
              <Placeholder align="left" description={t.noRunEvents} />
            ) : (
              <ol class="m-0 flex list-none flex-col gap-3 p-0">
                {props.events.map((event) => (
                  <li>
                    <article class="min-w-0">
                      <div class="flex items-center justify-between gap-2">
                        <span class="truncate text-[11px] font-medium text-primary">{event.name}</span>
                        <span class="shrink-0 text-[10px] text-dimmed">{formatDate(event.occurredAt, { locale: locale() })}</span>
                      </div>
                      <p class="mt-1 text-[10px] text-dimmed">{event.severity}</p>
                      {event.body ? <p class="mt-1 break-words text-[10px] text-primary">{event.body}</p> : null}
                      {event.attributes ? <StructuredDataPreview class="mt-1" data={traceData(event.attributes, t.invalidTraceData)} maxRows={6} /> : null}
                    </article>
                  </li>
                ))}
              </ol>
            )}
          </DetailPanel.Section>
        </DetailPanel.Body>
      </DetailPanel>
    </aside>
  );
}
