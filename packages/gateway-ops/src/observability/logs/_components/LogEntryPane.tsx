import { useLocale } from "@k2b/ui";
import { Band, Bar, Button, Chip, Empty, Facts, Failed, Pane, Prose, Section, Text, useToast } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { gatewayOpsMessages } from "../../../messages";
import type { LogEntry } from "../contracts";
import { logsMessages } from "../messages";
import { logRowFormatter, requestIdOf } from "../rows";

type Props = {
  selected: { entry: LogEntry | null; error: string | null } | null;
  timeZone: string;
  /** The list's address without the open entry. */
  closeHref: string;
  listLabel: string;
  /** Shows only the entries of this entry's request in the list beside it. */
  onRequest: (id: string) => void;
};

const valueText = (value: unknown): string =>
  value === null || value === undefined ? "null" : typeof value === "object" ? JSON.stringify(value) : String(value);

/** The open log entry beside the list: message, level, source, time, and its metadata as fields or raw JSON. */
export default function LogEntryPane(props: Props) {
  const locale = useLocale();
  const t = () => gatewayOpsMessages.resolve([locale()]).t;
  const words = () => logsMessages.resolve([locale()]).t;
  const [raw, setRaw] = createSignal(false);
  const toast = useToast();
  const dateFormat = () => new Intl.DateTimeFormat(locale(), { timeZone: props.timeZone, dateStyle: "medium" });
  // the time to the millisecond, as in the list's row; the day stands before it in words
  const clock = (open: LogEntry) => logRowFormatter(locale(), props.timeZone).row(open, "").time.split(" ").at(-1);
  const entry = () => props.selected?.entry ?? null;
  const level = (value: LogEntry["level"]) =>
    ({ debug: words().debug, info: words().info, warn: words().warn, error: words().error })[value];
  const title = () => {
    const open = entry();
    return open ? `${level(open.level)} · ${open.source}` : t().logEntry;
  };
  const json = () => JSON.stringify(entry(), null, 2);
  return (
    <Pane
      detail
      label={title()}
      back={{ label: props.listLabel, href: props.closeHref }}
      head={
        <Bar
          start={<Text type="lead">{title()}</Text>}
          end={
            <>
              <Show when={entry()}>
                <Button
                  variant="ghost"
                  icon="copy"
                  keep
                  label={t().copy}
                  onClick={() =>
                    void navigator.clipboard.writeText(json()).then(
                      () => toast(words().copied, { status: "ok" }),
                      () => toast(words().copyFailed, { status: "bad" }),
                    )
                  }
                />
              </Show>
              <Button variant="ghost" icon="x" label={t().close} href={props.closeHref} />
            </>
          }
        />
      }
    >
      <Show
        when={entry()}
        fallback={
          <Show
            when={props.selected?.error}
            fallback={
              <Empty
                icon="file-off"
                text={`${t().logEntryGone}. ${t().logEntryGoneDetail}`}
                action={{ label: t().backToLogs, href: props.closeHref }}
              />
            }
          >
            <Failed text={words().storeUnavailable} onRetry={() => location.reload()} />
          </Show>
        }
      >
        {(open) => (
          <>
            <Band>
              <Text type="body">{open().message}</Text>
            </Band>
            <Section
              icon="info-circle"
              title={t().detail}
              actions={(() => {
                const id = requestIdOf(open().metadata);
                return id ? [{ label: words().onlyThisRequest, icon: "filter", onClick: () => props.onRequest(id) }] : undefined;
              })()}
            >
              <Facts
                items={[
                  {
                    label: words().level,
                    value:
                      open().level === "error" ? (
                        <Chip status="bad">{level("error")}</Chip>
                      ) : open().level === "warn" ? (
                        <Chip status="warn">{level("warn")}</Chip>
                      ) : (
                        <Chip>{level(open().level)}</Chip>
                      ),
                  },
                  { label: words().source, value: open().source },
                  { label: words().at, value: `${dateFormat().format(new Date(open().createdAt))} · ${clock(open())}` },
                  { label: "ID", value: open().id, mono: true, copy: open().id },
                ]}
              />
            </Section>
            <Show when={open().metadata}>
              {(metadata) => (
                <Section
                  icon="braces"
                  title={t().metadata}
                  actions={[{ label: raw() ? t().viewFormatted : t().viewRaw, onClick: () => setRaw(!raw()) }]}
                >
                  <Show
                    when={raw()}
                    fallback={
                      <Facts
                        items={Object.entries(metadata()).map(([key, value]) => ({
                          label: key,
                          value: valueText(value),
                          mono: typeof value === "object" && value !== null,
                        }))}
                      />
                    }
                  >
                    <Prose markdown={`\`\`\`json\n${JSON.stringify(metadata(), null, 2)}\n\`\`\``} />
                  </Show>
                </Section>
              )}
            </Show>
          </>
        )}
      </Show>
    </Pane>
  );
}
