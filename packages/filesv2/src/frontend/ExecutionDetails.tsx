import { DescriptionList, Disclosure, Format, PanelHeader, StatusBadge } from "@k2b/ui";
import { Show } from "solid-js";
import type { ActivityEntry, ActivitySide } from "../activity-contracts";
import { useExecutionMessages } from "./execution-messages";
import { actorOf, actorParts, type HistoryEnvironment, plain, sentence, statusOf, viaLabel } from "./history-actions";
import { useHistoryMessages } from "./history-messages";

/** Read-only presentation of exactly one current reader projection. No writes, polling, or source lookup. */
export default function ExecutionDetails(props: { entry: ActivityEntry; timeZone: string }) {
  const t = useExecutionMessages();
  const h = useHistoryMessages();
  const env = (): HistoryEnvironment => ({ now: props.entry.time, timeZone: props.timeZone });
  const actor = () => actorOf(props.entry, h(), env());
  const status = () => statusOf(props.entry, h());
  const context = () => props.entry.execution;
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
      default:
        return t().unknownSource;
    }
  };
  const when = (value: string) => <Format.DateTime value={value} timeZone={props.timeZone} />;
  const references = () => [
    ...(context()?.origin ? [{ term: t().origin, description: origin() }] : []),
    ...(context()?.callingApp ? [{ term: t().callingApp, description: context()?.callingApp }] : []),
    ...(context()?.requestId ? [{ term: t().request, description: context()?.requestId }] : []),
    ...(context()?.invocationId ? [{ term: t().invocation, description: context()?.invocationId }] : []),
    ...(props.entry.startedAt !== props.entry.time ? [{ term: t().started, description: when(props.entry.startedAt) }] : []),
    ...(props.entry.finishedAt && props.entry.finishedAt !== props.entry.time
      ? [{ term: t().finished, description: when(props.entry.finishedAt) }]
      : []),
  ];
  return (
    <article class="mx-auto max-w-3xl space-y-6 break-words" data-print-region>
      <PanelHeader as="h1" size="lg" title={t().title} subtitle={t().scope} />
      <DescriptionList
        layout="rows"
        items={[
          { term: t().actor, description: plain(actorParts(actor(), h())) },
          {
            term: t().via,
            description: viaLabel(props.entry, h(), env()) ?? (props.entry.via.startsWith("app:") ? h().anotherApp : t().unknownSource),
          },
          {
            term: t().action,
            description: plain(
              sentence({ key: props.entry.id, kind: "single", lead: props.entry, entries: [props.entry] }, h(), env(), {
                context: "activity",
              }),
            ),
          },
          { term: t().result, description: <StatusBadge tone={status()?.tone ?? "ok"} label={status()?.label ?? t().done} /> },
          { term: t().time, description: when(props.entry.time) },
        ]}
      />
      <ExecutionSide side={props.entry.before} title={t().before} />
      <ExecutionSide side={props.entry.after} title={t().after} />
      <p class="text-sm text-secondary">{t().sourceUnavailable}</p>
      <Show when={references().length > 0}>
        <Disclosure summary={t().references} surface="plain">
          <p class="mb-4 text-sm text-secondary">{t().referenceNote}</p>
          <DescriptionList layout="compact" size="sm" items={references()} />
        </Disclosure>
      </Show>
    </article>
  );
}

function ExecutionSide(props: { side: ActivitySide; title: string }) {
  const t = useExecutionMessages();
  const side = () => (props.side.visibility !== "hidden" ? props.side : null);
  const historical = () => {
    const value = side();
    return value && (value.visibility !== "full" || value.source === "snapshot");
  };
  return (
    <Show when={side()}>
      {(visible) => (
        <section class="space-y-2">
          <PanelHeader title={props.title} />
          <p class="font-medium text-primary">{visible().name}</p>
          <p class="text-sm text-secondary">{visible().path}</p>
          <Show when={historical()}>
            <p class="text-sm text-secondary">{t().snapshot}</p>
          </Show>
        </section>
      )}
    </Show>
  );
}
