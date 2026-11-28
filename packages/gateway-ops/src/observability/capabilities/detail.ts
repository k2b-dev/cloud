import type { CapabilityExecution } from "@k2b/cloud/capabilities/store";
import { aiUsageHref, formatDateTime, formatDurationMs, formatNumber } from "@k2b/cloud/shared";
import type { DateContext } from "@k2b/stdlib";
import { statusLabel } from "./labels";
import { type CapabilityOpsMessages, capabilityOpsMessages } from "./ops-messages";
import { valueShape } from "./presentation";

/** One labelled value of a call; `mono` for identifiers a person copies. */
export type DetailFact = { label: string; value: string; mono?: boolean };

/** One dispatched call as the record beside the list shows it: correlation, timing and shape, never payloads. */
export type ExecutionDetailModel = {
  title: string;
  /** Several calls share one request (a retried or fanned-out call). */
  calls: number;
  sections: {
    title: string;
    status: CapabilityExecution["status"];
    statusLabel: string;
    destructive: boolean;
    facts: DetailFact[];
    aiUsageHref: string | null;
  }[];
  technical: DetailFact[];
};

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

/** The record of one request's calls, worded for a locale. */
export const executionDetail = (executions: CapabilityExecution[], locale: string, dateConfig?: DateContext): ExecutionDetailModel => {
  const { t } = capabilityOpsMessages.resolve([locale]);
  const label = (execution: CapabilityExecution) => `${execution.appId} · ${execution.capability}`;
  const originLabel = { assistant: t.originAssistant, mcp: t.originMcp, http: t.originHttp, app: t.originApp, choice: t.originChoice };
  const single = executions.length === 1;
  return {
    title: single && executions[0] ? label(executions[0]) : t.callCount({ count: executions.length }),
    calls: executions.length,
    sections: executions.map((execution) => ({
      title: single ? t.properties : label(execution),
      status: execution.status,
      statusLabel: statusLabel(execution.status, t),
      destructive: execution.destructive,
      facts: [
        { label: t.kind, value: execution.kind === "action" ? t.kindAction : t.kindQuery },
        { label: t.origin, value: originLabel[execution.origin] },
        {
          label: t.actor,
          value:
            execution.actorKind === "app" && execution.actorAppId
              ? `${t.app} · ${execution.actorAppId}`
              : // principal-id-labels: the record identifies the recorded actor by kind and ID.
                execution.actorId
                ? `${execution.actorKind ?? "—"} · ${execution.actorId}`
                : "—",
        },
        {
          label: t.accessSubject,
          value: execution.accessSubjectId ? `${execution.accessSubjectType ?? "—"} · ${execution.accessSubjectId}` : "—",
        },
        ...(execution.actorKind === "app" ? [{ label: t.appKeyId, value: execution.actorKeyId ?? "—", mono: true }] : []),
        { label: t.user, value: execution.userId ?? "—", mono: Boolean(execution.userId) },
        { label: t.startedAt, value: formatDateTime(execution.startedAt, dateConfig) },
        { label: t.completedAt, value: formatDateTime(execution.completedAt, dateConfig) },
        { label: t.duration, value: formatDurationMs(execution.durationMs, { locale }) },
        { label: t.errorCode, value: execution.errorCode ?? "—", mono: Boolean(execution.errorCode) },
        { label: t.input, value: shapeText(execution.inputMeta, t, locale) },
        { label: t.output, value: shapeText(execution.outputMeta, t, locale) },
      ],
      aiUsageHref: execution.userId && execution.origin === "assistant" ? aiUsageHref({ view: "runs", userId: execution.userId }) : null,
    })),
    technical: [
      { label: t.requestId, value: executions[0]?.requestId ?? "—", mono: true },
      ...executions.map((execution) => ({
        label: single ? t.idempotencyKey : `${t.idempotencyKey} · ${label(execution)}`,
        value: execution.idempotencyKey ?? "—",
        mono: Boolean(execution.idempotencyKey),
      })),
    ],
  };
};
