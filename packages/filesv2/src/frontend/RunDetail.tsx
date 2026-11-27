import {
  Band,
  Bar,
  Button,
  Disclosure,
  Empty,
  type Fact,
  Facts,
  Failed,
  type OnNavigate,
  Pane,
  type Status,
  Text,
  useLocale,
} from "@k2b/ui/v2";
import { Match, Show, Switch } from "solid-js";
import type { ActivityEntry, ActivitySide } from "../activity-contracts";
import { useExecutionMessages } from "./execution-messages";
import { actorOf, actorParts, type HistoryEnvironment, placeOf, plain, sentence, statusOf, viaLabel } from "./history-actions";
import { useHistoryMessages } from "./history-messages";
import type { RunSnapshot } from "./workspace-state";

/** A run that failed or is unclear says so in the colour of its meaning; a running or skipped one stays plain. */
const toneOf = (tone: string): Status | undefined => (tone === "error" ? "bad" : tone === "warning" ? "warn" : undefined);

/**
 * The run of one Activity entry, beside Activity's list (the former execution page, 27.11.): who did what through
 * which way, with what result, and the place before and after. Read-only, one current reader projection; no writes,
 * polling or source lookup. On the phone it is the page, with the way back to Activity.
 */
export default function RunDetail(props: {
  run: RunSnapshot;
  /** The screen's history environment: its time zone and how a storage and its folders are named. */
  env: HistoryEnvironment;
  /** Activity's address without the run. */
  closeHref: string;
  onNavigate: OnNavigate;
  onRetry: () => void;
}) {
  const t = useExecutionMessages();
  const h = useHistoryMessages();
  const entry = () => ("entry" in props.run ? props.run.entry : undefined);
  return (
    <Pane
      detail
      label={t().title}
      back={{ label: h().activity, href: props.closeHref, onNavigate: props.onNavigate }}
      head={
        <Bar
          start={<Text type="lead">{t().title}</Text>}
          end={<Button variant="ghost" icon="x" label={t().close} href={props.closeHref} onNavigate={props.onNavigate} />}
        />
      }
    >
      <Switch>
        <Match when={entry()}>{(value) => <RunFacts entry={value()} env={props.env} />}</Match>
        <Match when={"problem" in props.run && props.run.problem === "failed"}>
          <Failed text={t().failed} onRetry={props.onRetry} />
        </Match>
        <Match when>
          <Empty icon="player-play" text={t().missing} />
        </Match>
      </Switch>
    </Pane>
  );
}

function RunFacts(props: { entry: ActivityEntry; env: HistoryEnvironment }) {
  const t = useExecutionMessages();
  const h = useHistoryMessages();
  const locale = useLocale();
  // the words of its Activity row, its places named as the path names them ("Werkstatt › Büro")
  const env = (): HistoryEnvironment => ({ ...props.env, now: props.entry.time });
  const status = () => statusOf(props.entry, h());
  const context = () => props.entry.execution;
  // a recorded instant, in the reader's zone and language; the machine-readable instant stays with it
  const when = (value: string) => (
    <time datetime={new Date(value).toISOString()}>
      {new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "medium", timeZone: props.env.timeZone }).format(
        new Date(value),
      )}
    </time>
  );
  const origin = () => {
    switch (context()?.origin) {
      case "assistant":
        return t().originAssistant;
      case "mcp":
        return t().originMcp;
      case "http":
        return t().originHttp;
      case "app":
        return t().originApp;
      case "choice":
        return t().originChoice;
      default:
        return t().unknownSource;
    }
  };
  const side = (value: ActivitySide, label: string): Fact[] =>
    value.visibility === "hidden"
      ? []
      : [
          {
            label,
            value: value.name,
            // where it lay, as the path names it; a place that was only recorded says "damals"
            hint: [
              placeOf(env(), { kind: "side", side: value }).join(" › "),
              ...(value.visibility !== "full" || value.source === "snapshot" ? [t().then] : []),
            ]
              .filter(Boolean)
              .join(" · "),
          },
        ];
  const references = (): Fact[] => [
    ...(context()?.origin ? [{ label: t().origin, value: origin() }] : []),
    ...(context()?.callingApp ? [{ label: t().callingApp, value: context()!.callingApp! }] : []),
    ...(context()?.requestId ? [{ label: t().request, value: context()!.requestId!, mono: true, copy: context()!.requestId! }] : []),
    ...(context()?.invocationId
      ? [{ label: t().invocation, value: context()!.invocationId!, mono: true, copy: context()!.invocationId! }]
      : []),
    ...(props.entry.startedAt !== props.entry.time ? [{ label: t().started, value: when(props.entry.startedAt) }] : []),
    ...(props.entry.finishedAt && props.entry.finishedAt !== props.entry.time
      ? [{ label: t().finished, value: when(props.entry.finishedAt) }]
      : []),
  ];
  return (
    <>
      {/* what happened leads, in the words of its Activity row; who, which way, the result and when follow as pairs */}
      <Band>
        <Text type="body" weight="medium">
          {plain(
            sentence({ key: props.entry.id, kind: "single", lead: props.entry, entries: [props.entry] }, h(), env(), {
              context: "activity",
            }),
          )}
        </Text>
      </Band>
      <Facts
        items={[
          { label: t().actor, value: plain(actorParts(actorOf(props.entry, h(), env()), h())) },
          // the way only where it has words for people; who acted already says on whose behalf
          ...(viaLabel(props.entry, h(), env()) ? [{ label: t().via, value: viaLabel(props.entry, h(), env())! }] : []),
          {
            label: t().result,
            value: (
              // a run that went well stays neutral; colour only for what went wrong (B rule 7)
              <Text tone={status() ? toneOf(status()!.tone) : undefined} weight="medium">
                {status()?.label ?? t().done}
              </Text>
            ),
          },
          { label: t().time, value: when(props.entry.time) },
          ...side(props.entry.before, t().before),
          ...side(props.entry.after, t().after),
        ]}
      />
      <Show when={references().length > 0}>
        <Disclosure title={t().references}>
          <Facts items={references()} />
        </Disclosure>
      </Show>
    </>
  );
}
