import { ButtonLink, DescriptionList, DetailPanel, IconButtonLink, StatusBadge, useLocale } from "@k2b/ui";
import { aiUsageHref, formatDateTime, formatDurationMs, formatNumber } from "@k2b/cloud/shared";
import type { CapabilityExecution } from "@k2b/cloud/capabilities/store";
import type { DateContext } from "@k2b/stdlib";
import type { JSX } from "solid-js";
import { type CapabilityOpsMessages, capabilityOpsMessages } from "../ops-messages";
import { ORIGIN_ICON, STATUS_TONE, valueShape } from "../presentation";
import { statusLabel } from "../labels";

const shapeText = (meta: CapabilityExecution["inputMeta"], t: CapabilityOpsMessages, locale: string): string => {
  const shape = valueShape(meta);
  if (!shape) return "—";
  const number = (value: number) => formatNumber(value, { locale });
  const type = {
    object: t.shapeObject,
    array: t.shapeArray,
    string: t.shapeString,
    number: t.shapeNumber,
    boolean: t.shapeBoolean,
    null: t.shapeNull,
    unknown: t.shapeUnknown,
  }[shape.type];
  if (shape.type === "object") {
    const keys = shape.keys.join(", ");
    const more = shape.omittedKeys > 0 ? ` ${t.shapeMore({ count: shape.omittedKeys })}` : "";
    return keys ? `${type} · ${t.shapeKeys}: ${keys}${more}` : type;
  }
  if (shape.type === "array") return `${type} · ${t.shapeItems({ count: number(shape.size ?? 0) })}`;
  if (shape.type === "string") return `${type} · ${t.shapeChars({ count: number(shape.size ?? 0) })}`;
  if (shape.value !== null) return `${type} · ${shape.value}`;
  return type;
};

const mono = (value: string | null): JSX.Element =>
  value ? <span class="font-mono text-[11px] break-all select-all">{value}</span> : <span class="text-dimmed">—</span>;

/**
 * One dispatched capability call. The panel deliberately shows correlation,
 * timing and shape only — the store never holds the payloads, and the detail
 * must not imply that it does.
 */
export default function ExecutionDetail(props: {
  executions: CapabilityExecution[];
  closeHref: string;
  dateConfig?: DateContext;
}) {
  const locale = useLocale()();
  const { t } = capabilityOpsMessages.resolve([locale]);
  return (
    <aside id="capability-execution-detail" class="paper p-3" aria-label={t.detailTitle}>
      <DetailPanel>
        <DetailPanel.Header
          title={t.detailTitle}
          actions={
            <IconButtonLink href={props.closeHref} label={t.close}>
              <i class="ti ti-x" />
            </IconButtonLink>
          }
        />
        <DetailPanel.Body>
          <p class="text-xs text-dimmed">{t.detailHint}</p>
          {props.executions.map((execution) => (
            <DetailPanel.Section title={`${execution.appId} · ${execution.capability}`}>
              <div class="flex flex-wrap items-center gap-2">
                <StatusBadge tone={STATUS_TONE[execution.status]} label={statusLabel(execution.status, t)} variant="dot" />
                <span class="text-xs text-secondary">
                  <i class={ORIGIN_ICON[execution.origin]} /> {execution.origin}
                </span>
                <span class="text-xs text-secondary">{execution.kind === "action" ? t.kindAction : t.kindQuery}</span>
                {execution.destructive ? (
                  <StatusBadge tone="warning" label={t.destructive} variant="dot" />
                ) : null}
              </div>
              <DescriptionList
                layout="rows"
                size="sm"
                items={[
                  { term: t.requestId, description: mono(execution.requestId) },
                  {
                    term: t.actor,
                    description: execution.actorId ? (
                      <span class="break-all select-all">
                        {execution.actorKind ?? "—"} · {execution.actorId}
                      </span>
                    ) : (
                      "—"
                    ),
                  },
                  {
                    term: t.accessSubject,
                    description: execution.accessSubjectId
                      ? `${execution.accessSubjectType ?? "—"} · ${execution.accessSubjectId}`
                      : "—",
                  },
                  { term: t.user, description: mono(execution.userId) },
                  { term: t.startedAt, description: formatDateTime(execution.startedAt, props.dateConfig) },
                  { term: t.completedAt, description: formatDateTime(execution.completedAt, props.dateConfig) },
                  { term: t.duration, description: formatDurationMs(execution.durationMs, { locale }) },
                  { term: t.errorCode, description: execution.errorCode ? mono(execution.errorCode) : "—" },
                  { term: t.input, description: shapeText(execution.inputMeta, t, locale) },
                  { term: t.output, description: shapeText(execution.outputMeta, t, locale) },
                  { term: t.idempotencyKey, description: mono(execution.idempotencyKey) },
                ]}
              />
              {execution.userId && execution.origin === "assistant" ? (
                <ButtonLink variant="text" size="sm" href={aiUsageHref({ view: "runs", userId: execution.userId })}>
                  {t.aiUsage}
                </ButtonLink>
              ) : null}
            </DetailPanel.Section>
          ))}
        </DetailPanel.Body>
      </DetailPanel>
    </aside>
  );
}
