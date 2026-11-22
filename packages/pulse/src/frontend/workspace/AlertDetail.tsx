import { Button, ButtonLink, DescriptionList, DetailPanel, IconButton, Section, StatusBadge } from "@k2b/ui";
import { Show } from "solid-js";
import type { AlertAttention } from "../../service/base-attention";
import { usePulseMessages } from "../use-messages";
import type { PulseDateContext } from "./helpers";
import { absoluteTime, ago } from "./SourcesTab";

/** A fired alert in the detail column: the condition in words, its value, since when, and the way to change it. */
export default function AlertDetail(props: {
  alert: AlertAttention;
  sqlHref: string;
  dateContext: PulseDateContext;
  adjust: () => void;
  adjustPending: boolean;
  close: () => void;
}) {
  const t = usePulseMessages();
  const tone = () => (props.alert.state === "firing" && props.alert.severity === "critical" ? "error" : "warning");
  const stateLabel = () =>
    props.alert.state === "firing"
      ? props.alert.severity === "critical"
        ? t().severityCritical
        : t().severityWarning
      : props.alert.state === "error"
        ? t().error
        : t().noDataYet;
  return (
    <DetailPanel>
      <DetailPanel.Header
        kind={<StatusBadge tone={tone()} label={stateLabel()} />}
        title={props.alert.name}
        subtitle={t().alertDetailsTitle}
        actions={
          <IconButton label={t().closeDetails} variant="ghost" size="sm" onClick={props.close}>
            <i class="ti ti-x" aria-hidden="true" />
          </IconButton>
        }
        primaryActions={
          <div class="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" loading={props.adjustPending} onClick={props.adjust}>
              <i class="ti ti-sparkles pulse-ai-icon" aria-hidden="true" />
              {t().adjustWithGustav}
            </Button>
            <ButtonLink variant="secondary" size="sm" href={props.sqlHref}>
              <i class="ti ti-code" aria-hidden="true" />
              {t().openAlertSql}
            </ButtonLink>
          </div>
        }
      />
      <DetailPanel.Body>
        <Section title={t().alertCondition} icon="ti ti-bell-ringing">
          <p class="pulse-detail-text">
            <Show
              when={props.alert.threshold !== null}
              fallback={
                props.alert.errorCode ? t().alertCheckFailed({ code: props.alert.errorCode }) : t().alertNoData({ name: props.alert.name })
              }
            >
              {t().alertConditionWords({ comparison: props.alert.comparison, threshold: String(props.alert.threshold) })}
            </Show>
          </p>
          <DescriptionList
            layout="rows"
            size="sm"
            items={[
              ...(props.alert.value === null ? [] : [{ term: t().alertValue, description: String(props.alert.value) }]),
              ...(props.alert.key
                ? [{ term: t().alertSeries, description: <span class="font-mono text-xs">{props.alert.key}</span> }]
                : []),
              { term: t().alertSince, description: absoluteTime(props.alert.since, props.dateContext) },
              ...(props.alert.lastCheckedAt
                ? [{ term: t().alertLastChecked, description: ago(props.alert.lastCheckedAt, props.dateContext) }]
                : []),
            ]}
          />
        </Section>
      </DetailPanel.Body>
    </DetailPanel>
  );
}
