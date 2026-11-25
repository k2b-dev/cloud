import { useLocale } from "@k2b/ui";
import { Bar, Button, Chip, Empty, Facts, Failed, List, Notice, Pane, Row, Section, Text } from "@k2b/ui/v2";
import { Show } from "solid-js";
import { runsMessages } from "../messages";
import type { RunRef } from "../query";
import type { RunRecord } from "../service";

type Props = {
  ref: RunRef;
  record: { record: RunRecord | null; error: string | null } | null;
  timeZone: string;
  /** The list without the open run. */
  closeHref: string;
  kindLabel: string;
};

/** The open run beside the list: a job run with its events, or a delivery with its recipient and error. */
export default function RunRecordPane(props: Props) {
  const locale = useLocale();
  const t = () => runsMessages.resolve([locale()]).t;
  const when = (value: string | Date | null | undefined) => {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? String(value)
      : new Intl.DateTimeFormat(locale(), { timeZone: props.timeZone, dateStyle: "medium", timeStyle: "medium" }).format(date);
  };
  const ms = (value: number | null | undefined) =>
    value === null || value === undefined ? "—" : `${new Intl.NumberFormat(locale()).format(Math.round(value))} ms`;
  const title = () => {
    const record = props.record?.record;
    if (!record) return props.kindLabel;
    return record.kind === "job" ? record.span.name : record.item.title || record.item.label;
  };
  return (
    <Pane
      detail
      label={title()}
      back={{ label: t().runs, href: props.closeHref }}
      head={
        <Bar
          start={<Text type="lead">{title()}</Text>}
          end={<Button variant="ghost" icon="x" label={t().closeRecord} href={props.closeHref} />}
        />
      }
    >
      <Show
        when={props.record?.record}
        fallback={
          <Show
            when={props.record?.error}
            fallback={<Empty icon="file-off" text={t().gone} action={{ label: t().runs, href: props.closeHref }} />}
          >
            <Failed text={t().recordUnavailable} onRetry={() => location.reload()} />
          </Show>
        }
      >
        {(record) => {
          const value = record();
          if (value.kind === "job") {
            const span = value.span;
            const failed = span.status === "error";
            return (
              <>
                <Show when={span.statusMessage}>
                  <Notice tone={failed ? "bad" : "note"}>{span.statusMessage}</Notice>
                </Show>
                <Section icon="info-circle" title={t().record}>
                  <Facts
                    items={[
                      { label: t().kind, value: props.kindLabel },
                      {
                        label: t().status,
                        value: !span.endedAt ? (
                          <Chip>{t().running}</Chip>
                        ) : failed ? (
                          <Chip status="bad">{t().failed}</Chip>
                        ) : (
                          <Chip status="ok">{t().succeeded}</Chip>
                        ),
                      },
                      { label: t().source, value: span.source },
                      { label: t().app, value: span.appId ?? "—" },
                      { label: t().started, value: when(span.startedAt) },
                      { label: t().ended, value: when(span.endedAt) },
                      { label: t().duration, value: ms(span.durationMs) },
                      { label: t().traceId, value: `${span.traceId}:${span.spanId}`, mono: true, copy: `${span.traceId}:${span.spanId}` },
                    ]}
                  />
                </Section>
                <Section icon="list" title={t().events} count={value.events.length}>
                  <Show when={value.events.length > 0} fallback={<Text muted>{t().noEvents}</Text>}>
                    <List label={t().events}>
                      {value.events.map((event) => (
                        <Row
                          icon={event.severity === "error" ? "alert-circle" : "point"}
                          lines={event.body ? [event.name, event.body] : [event.name]}
                          time={when(event.occurredAt)}
                        />
                      ))}
                    </List>
                  </Show>
                </Section>
              </>
            );
          }
          const item = value.item;
          return (
            <>
              <Show when={item.errorMessage || item.errorCode}>
                <Notice tone="bad" title={item.errorCode ?? t().error}>
                  {item.errorMessage ?? item.errorCode}
                </Notice>
              </Show>
              <Section
                icon="info-circle"
                title={t().record}
                actions={item.targetHref ? [{ label: t().openTarget, icon: "external-link", href: item.targetHref }] : undefined}
              >
                <Facts
                  items={[
                    { label: t().kind, value: props.kindLabel },
                    { label: t().status, value: item.status },
                    { label: t().app, value: item.appId },
                    { label: t().recipient, value: item.recipientLabel ?? "—" },
                    { label: t().channel, value: [item.channel, item.destinationLabel].filter(Boolean).join(" · ") },
                    { label: t().attempts, value: String(item.attemptCount) },
                    { label: t().started, value: when(item.createdAt) },
                    { label: t().ended, value: when(item.deliveredAt) },
                    { label: "ID", value: item.id, mono: true, copy: item.id },
                  ]}
                />
              </Section>
            </>
          );
        }}
      </Show>
    </Pane>
  );
}
