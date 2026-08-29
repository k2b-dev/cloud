import {
  Button,
  DescriptionList,
  DetailPanel,
  IconButton,
  isStructuredDataValue,
  StructuredDataPreview,
  type StructuredDataValue,
  Tooltip,
} from "@k2b/ui";
import { Show } from "solid-js";
import type { PulseCurrentState, PulseMetricSeries, PulseRecordedEvent } from "../../contracts";
import { compactDateWithDelta, formatMetricValue, formatSignalValue, formatValue, type PulseDateContext, signalSubject } from "./helpers";
import { usePulseMessages } from "../use-messages";

const structuredData = (value: unknown, label: string): StructuredDataValue =>
  isStructuredDataValue(value) ? value : { error: `${label} is not valid JSON.` };

type SourceProps = {
  sourceId: string | null | undefined;
  sourceNameById: () => Map<string, string>;
  dateContext: PulseDateContext;
  openSource: (sourceId: string | null | undefined) => void;
  openQuery: () => void;
  close: () => void;
};

const SourceAction = (props: SourceProps) => {
  const t = usePulseMessages();
  return (
  <Show when={props.sourceId} fallback={<p class="text-xs text-dimmed">-</p>}>
    {(sourceId) => (
      <DetailPanel.Action
        type="button"
        title={props.sourceNameById().get(sourceId()) ?? t().unknownSource}
        description={t().openSource}
        leading={<i class="ti ti-database-share" aria-hidden="true" />}
        trailing={<i class="ti ti-chevron-right" aria-hidden="true" />}
        onClick={() => props.openSource(sourceId())}
      />
    )}
  </Show>
  );
};

const DetailClose = (props: SourceProps) => {
  const t = usePulseMessages();
  return (
  <Tooltip.Anchor content={t().closeDetails}>
    <IconButton label={t().closeSignalDetails} variant="ghost" size="sm" onClick={props.close}>
      <i class="ti ti-x" />
    </IconButton>
  </Tooltip.Anchor>
  );
};

const DetailQuickActions = (props: SourceProps) => {
  const t = usePulseMessages();
  return (
  <>
    <Button type="button" variant="secondary" size="sm" onClick={props.openQuery}>
      <i class="ti ti-code" /> {t().openQuery}
    </Button>
    {props.sourceId ? (
      <Button type="button" variant="secondary" size="sm" onClick={() => props.openSource(props.sourceId)}>
        <i class="ti ti-database-share" /> {t().source}
      </Button>
    ) : null}
  </>
  );
};

export const FocusedMetricSeriesDetail = (
  props: SourceProps & { item: PulseMetricSeries; metricName: string; metricUnit: string | null },
) => {
  const t = usePulseMessages();
  return (
  <DetailPanel>
    <DetailPanel.Header
      title={signalSubject(props.item)}
      icon="ti ti-chart-dots"
      meta={t().metricVariant}
      subtitle={
        <>
          {props.metricName} · {props.sourceNameById().get(props.item.sourceId ?? "") ?? t().noSource}
        </>
      }
      actions={<DetailClose {...props} />}
      primaryActions={
        <div class="flex flex-wrap items-center gap-2" role="group" aria-label={t().actionsFor({ name: signalSubject(props.item) })}>
          <DetailQuickActions {...props} />
        </div>
      }
    />
    <DetailPanel.Body>
      <DetailPanel.Summary title={t().variant}>
        <DescriptionList
          items={[
            {
              term: t().current,
              description: props.item.latestValue === null ? "-" : formatMetricValue(props.item.latestValue, props.metricUnit),
            },
            { term: t().metric, description: props.metricName },
            { term: t().subject, description: signalSubject(props.item) },
            {
              term: t().lastSeen,
              description:
                (props.item.latestSampleAt ?? props.item.lastSeenAt)
                  ? compactDateWithDelta((props.item.latestSampleAt ?? props.item.lastSeenAt)!, props.dateContext)
                  : "-",
            },
          ]}
          layout="rows"
          size="sm"
        />
      </DetailPanel.Summary>
      <DetailPanel.Group label={t().signalContext}>
        <DetailPanel.Section title={t().source} icon="ti ti-database-share" tone="accent">
          <SourceAction {...props} sourceId={props.item.sourceId} />
        </DetailPanel.Section>
        <DetailPanel.Section title={t().dimensions} icon="ti ti-tags" tone="neutral">
          <StructuredDataPreview data={props.item.dimensions} empty={t().noDimensions} />
        </DetailPanel.Section>
      </DetailPanel.Group>
    </DetailPanel.Body>
  </DetailPanel>
  );
};

export const FocusedStateDetail = (props: SourceProps & { state: PulseCurrentState }) => {
  const t = usePulseMessages();
  return (
  <DetailPanel>
    <DetailPanel.Header
      title={signalSubject(props.state)}
      icon="ti ti-toggle-right"
      meta={t().stateVariant}
      subtitle={
        <>
          {props.state.key} · {props.sourceNameById().get(props.state.sourceId ?? "") ?? t().noSource}
        </>
      }
      actions={<DetailClose {...props} />}
      primaryActions={
        <div class="flex flex-wrap items-center gap-2" role="group" aria-label={t().actionsFor({ name: signalSubject(props.state) })}>
          <DetailQuickActions {...props} />
        </div>
      }
    />
    <DetailPanel.Body>
      <DetailPanel.Summary title={t().currentValue}>
        <DescriptionList
          items={[
            { term: t().value, description: formatSignalValue(props.state.value) },
            { term: t().subject, description: signalSubject(props.state) },
            { term: t().updated, description: compactDateWithDelta(props.state.updatedAt, props.dateContext) },
          ]}
          layout="rows"
          size="sm"
        />
      </DetailPanel.Summary>
      <DetailPanel.Group label={t().signalContext}>
        <DetailPanel.Section title={t().source} icon="ti ti-database-share" tone="accent">
          <SourceAction {...props} sourceId={props.state.sourceId} />
        </DetailPanel.Section>
        <DetailPanel.Section title={t().dimensions} icon="ti ti-tags" tone="neutral">
          <StructuredDataPreview data={props.state.dimensions} empty={t().noDimensions} />
        </DetailPanel.Section>
      </DetailPanel.Group>
    </DetailPanel.Body>
  </DetailPanel>
  );
};

export const FocusedEventDetail = (props: SourceProps & { event: PulseRecordedEvent }) => {
  const t = usePulseMessages();
  return (
  <DetailPanel>
    <DetailPanel.Header
      title={signalSubject(props.event)}
      icon="ti ti-bolt"
      meta={t().eventRow}
      subtitle={
        <>
          {props.event.kind} · {props.sourceNameById().get(props.event.sourceId ?? "") ?? t().noSource}
        </>
      }
      actions={<DetailClose {...props} />}
      primaryActions={
        <div class="flex flex-wrap items-center gap-2" role="group" aria-label={t().actionsFor({ name: signalSubject(props.event) })}>
          <DetailQuickActions {...props} />
        </div>
      }
    />
    <DetailPanel.Body>
      <DetailPanel.Summary title={t().event}>
        <DescriptionList
          items={[
            { term: t().kind, description: props.event.kind },
            { term: t().value, description: props.event.value === null ? "-" : formatValue(props.event.value) },
            { term: t().subject, description: signalSubject(props.event) },
            { term: t().time, description: compactDateWithDelta(props.event.ts, props.dateContext) },
          ]}
          layout="rows"
          size="sm"
        />
      </DetailPanel.Summary>
      <DetailPanel.Group label={t().signalContext}>
        <DetailPanel.Section title={t().source} icon="ti ti-database-share" tone="accent">
          <SourceAction {...props} sourceId={props.event.sourceId} />
        </DetailPanel.Section>
        <DetailPanel.Section title={t().dimensions} icon="ti ti-tags" tone="neutral">
          <StructuredDataPreview data={props.event.dimensions} empty={t().noDimensions} />
        </DetailPanel.Section>
        <DetailPanel.Section title={t().payload} icon="ti ti-braces" tone="neutral">
          <StructuredDataPreview data={structuredData(props.event.payload, t().eventPayload)} empty={t().noPayload} />
        </DetailPanel.Section>
      </DetailPanel.Group>
    </DetailPanel.Body>
  </DetailPanel>
  );
};
