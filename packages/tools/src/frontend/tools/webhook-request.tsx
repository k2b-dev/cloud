import type { Column, OnNavigate } from "@k2b/ui/v2";
import { Bar, Button, Chip, Empty, Facts, Pane, Prose, Section, Table, Text, useToast } from "@k2b/ui/v2";
import { createSignal, For, Show } from "solid-js";
import { methodColors } from "../tools-colors";
import type { WebhookMessages } from "./webhook-messages";
import type { WebhookLog } from "./webhook-queries";

/** How a time reads in this list: "heute, 09:42" today, else the date and the time, in the person's zone. */
export const timeReader = (locale: string, timeZone: string, now: string, t: WebhookMessages) => {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const clock = new Intl.DateTimeFormat(locale, { timeZone, hour: "2-digit", minute: "2-digit" });
  const date = new Intl.DateTimeFormat(locale, { timeZone, day: "2-digit", month: "2-digit", year: "numeric" });
  const today = day.format(new Date(now));
  return (value: string) => {
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) return value;
    return day.format(at) === today ? t.today({ time: clock.format(at) }) : `${date.format(at)}, ${clock.format(at)}`;
  };
};

export const MethodChip = (props: { method: string }) => (
  <Chip tag color={methodColors[props.method]}>
    {props.method}
  </Chip>
);

/** The answer as state: a received request is logged; a sent one shows its status code, or the failure. */
export const StatusChip = (props: { log: WebhookLog; t: WebhookMessages }) => (
  <Show when={!props.log.error} fallback={<Chip status="bad">{props.t.statusError}</Chip>}>
    <Show when={props.log.responseStatus} fallback={<Chip status="ok">{props.t.statusLogged}</Chip>}>
      {(code) => <Chip status={code() >= 500 ? "bad" : code() >= 300 ? "warn" : "ok"}>{String(code())}</Chip>}
    </Show>
  </Show>
);

export const targetOf = (log: WebhookLog) => log.path || log.url;
const kindAndSize = (log: WebhookLog) =>
  [log.requestContentType?.split(";")[0], log.requestBody ? `${new TextEncoder().encode(log.requestBody).length} B` : null]
    .filter(Boolean)
    .join(" · ") || "–";
const hostAndDuration = (log: WebhookLog) => {
  const host = URL.canParse(log.url) ? new URL(log.url).host : log.url;
  return log.durationMs === null ? host : `${host} · ${log.durationMs} ms`;
};
export const shortBody = (value: string | null) => {
  if (!value) return "–";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 140 ? `${compact.slice(0, 140)}…` : compact;
};

/**
 * The requests of the open view, newest first. The service returns the newest 100 per address; the table keeps only
 * the rows in view once the v2 table windows its rows (#4211), so a longer log stays light.
 */
export const RequestTable = (props: {
  label: string;
  rows: WebhookLog[];
  current: string | null;
  t: WebhookMessages;
  when: (value: string) => string;
  href: (id: string) => string;
  onOpen: (id: string) => OnNavigate;
  empty: { icon: string; text: string; action?: { label: string; icon: string; href: string } };
  /** Received requests name their endpoint (each was logged, so they need no state); sent ones show the answer. */
  endpointOf?: (log: WebhookLog) => string;
}) => {
  const columns = (): Column<WebhookLog>[] => {
    const method: Column<WebhookLog> = {
      title: props.t.colMethod,
      width: { min: 88, default: 92 },
      cell: (row) => <MethodChip method={row.method} />,
    };
    const time: Column<WebhookLog> = {
      title: props.t.colTime,
      width: { min: 104, default: 120 },
      cell: (row) => props.when(row.createdAt),
    };
    // the body takes what is left and gives way first; the content type stands in the open request
    const body: Column<WebhookLog> = { title: props.t.colBody, cell: (row) => shortBody(row.requestBody), drop: true };
    const endpointOf = props.endpointOf;
    if (endpointOf)
      return [method, { title: props.t.filterEndpoint, width: { min: 140, default: 180 }, cell: (row) => endpointOf(row) }, time, body];
    return [
      method,
      { title: props.t.colTarget, width: { min: 120, default: 150 }, cell: (row) => targetOf(row) },
      { title: props.t.colStatus, width: { min: 96, default: 104 }, cell: (row) => <StatusChip log={row} t={props.t} /> },
      time,
      body,
    ];
  };
  return (
    <Table
      label={props.label}
      rows={props.rows}
      rowKey={(row) => row.id}
      current={props.current ?? undefined}
      open={(row) => ({ href: props.href(row.id), onNavigate: props.onOpen(row.id) })}
      empty={props.empty}
      // k2b-ui gap: a phone row's second line is not cut to one line; a long unbreakable text (a JSON body) wraps under
      // the marks. Until it is, the second line stays short: the content type and size, or the host and duration.
      phone={(row) => ({
        lines: [props.endpointOf?.(row) ?? targetOf(row), props.endpointOf ? kindAndSize(row) : hostAndDuration(row)],
        time: props.when(row.createdAt),
        marks: props.endpointOf ? <MethodChip method={row.method} /> : <StatusChip log={row} t={props.t} />,
      })}
      columns={columns()}
    />
  );
};

const parseJsonLike = (value: unknown): { ok: true; value: unknown } | { ok: false; value: string } => {
  if (value === null || value === undefined) return { ok: false, value: "" };
  if (typeof value !== "string") return { ok: true, value };
  let current: unknown = value.trim();
  // a body may hold JSON as a JSON string; read it at most twice
  for (let round = 0; round < 2; round++) {
    if (typeof current !== "string") return { ok: true, value: current };
    const trimmed = current.trim();
    if (!trimmed || !["{", "[", '"'].includes(trimmed[0] ?? "")) break;
    try {
      current = JSON.parse(trimmed);
    } catch {
      break;
    }
  }
  return typeof current === "string" ? { ok: false, value: current } : { ok: true, value: current };
};
const rawText = (value: unknown) =>
  value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
const valueText = (value: unknown) =>
  value === null || value === undefined ? "null" : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
/** Raw text as a code block whose fence is longer than any run of backticks inside it. */
const codeBlock = (text: string) => {
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((run) => run[0].length + 1)));
  return `${fence}\n${text}\n${fence}`;
};

/** A body or the headers of a request: its fields as facts, or the raw text; both can be copied. */
const Part = (props: { icon: string; title: string; value: unknown; t: WebhookMessages; copy: (text: string) => void }) => {
  const [raw, setRaw] = createSignal(false);
  const parsed = () => parseJsonLike(props.value);
  const fields = () => {
    const data = parsed();
    if (!data.ok) return [];
    if (Array.isArray(data.value)) return data.value.map((value, index) => [String(index), value] as const);
    if (data.value && typeof data.value === "object") return Object.entries(data.value);
    return [["value", data.value] as const];
  };
  const text = () => rawText(props.value);
  return (
    <Section
      icon={props.icon}
      title={props.title}
      actions={
        text()
          ? parsed().ok
            ? [
                { label: raw() ? props.t.pretty : props.t.raw, icon: raw() ? "list-details" : "code", onClick: () => setRaw(!raw()) },
                { label: props.t.copy, icon: "copy", onClick: () => props.copy(text()) },
              ]
            : [{ label: props.t.copy, icon: "copy", onClick: () => props.copy(text()) }]
          : undefined
      }
    >
      <Show
        when={text()}
        fallback={
          <Text type="meta" muted>
            {props.t.noBody}
          </Text>
        }
      >
        <Show when={parsed().ok && !raw() && fields().length > 0} fallback={<Prose markdown={codeBlock(text())} />}>
          <Facts
            items={fields().map(([label, value]) => ({
              label,
              value: valueText(value),
              mono: typeof value === "object" && value !== null,
            }))}
          />
        </Show>
      </Show>
    </Section>
  );
};

/** The open request beside the list: what came or went, its answer, both bodies and both header sets. */
export const RequestPane = (props: {
  log: WebhookLog | undefined;
  endpointName: string | undefined;
  t: WebhookMessages;
  when: (value: string) => string;
  listLabel: string;
  closeHref: string;
  onClose: OnNavigate;
}) => {
  const toast = useToast();
  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(
      () => toast(props.t.copied, { status: "ok" }),
      () => toast(props.t.copyFailed, { status: "bad" }),
    );
  const kind = (log: WebhookLog) => (log.direction === "incoming" ? props.t.incomingRequest : props.t.outgoingRequest);
  const title = () => (props.log ? (props.endpointName ?? kind(props.log)) : props.t.requests);
  return (
    <Pane
      detail
      label={title()}
      back={{ label: props.listLabel, href: props.closeHref, onNavigate: props.onClose }}
      head={
        <Bar
          start={<Text type="lead">{title()}</Text>}
          end={
            <>
              <Show when={props.log}>
                {(log) => (
                  <Button variant="ghost" icon="braces" label={props.t.copyJson} onClick={() => copy(JSON.stringify(log(), null, 2))} />
                )}
              </Show>
              <Button variant="ghost" icon="x" label={props.t.close} href={props.closeHref} onNavigate={props.onClose} />
            </>
          }
        />
      }
    >
      <Show when={props.log} fallback={<Empty icon="file-off" text={props.t.requestGone} />}>
        {(log) => (
          <>
            <Section icon="info-circle" title={kind(log())}>
              <Facts
                items={[
                  { label: props.t.methodLabel, value: <MethodChip method={log().method} /> },
                  { label: props.t.colStatus, value: <StatusChip log={log()} t={props.t} /> },
                  { label: props.t.address, value: log().url, mono: true, copy: log().url },
                  ...(log().query ? [{ label: props.t.queryLabel, value: log().query, mono: true }] : []),
                  { label: props.t.contentType, value: log().requestContentType ?? "–" },
                  { label: props.t.duration, value: log().durationMs === null ? "–" : `${log().durationMs} ms` },
                  { label: props.t.at, value: props.when(log().createdAt) },
                  ...(log().error ? [{ label: props.t.statusError, value: log().error ?? "" }] : []),
                ]}
              />
            </Section>
            <Part icon="file-upload" title={props.t.requestBody} value={log().requestBody} t={props.t} copy={copy} />
            <Show when={log().direction === "outgoing"}>
              <Part icon="file-download" title={props.t.responseBody} value={log().responseBody ?? log().error} t={props.t} copy={copy} />
            </Show>
            <For
              each={[
                { title: props.t.requestHeaders, value: log().requestHeaders },
                ...(log().direction === "outgoing" ? [{ title: props.t.responseHeaders, value: log().responseHeaders }] : []),
              ]}
            >
              {(part) => <Part icon="list" title={part.title} value={part.value} t={props.t} copy={copy} />}
            </For>
          </>
        )}
      </Show>
    </Pane>
  );
};
