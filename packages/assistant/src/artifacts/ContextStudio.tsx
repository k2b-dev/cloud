import { DataTable, Placeholder, useLocale } from "@k2b/ui";
import { For, Show } from "solid-js";
import type { AssistantChatContextSnapshot } from "../chat-context";
import { createArtifactActions } from "./artifact-actions";
import { StudioCard } from "./StudioCard";

export function ContextStudio(props: { snapshot: AssistantChatContextSnapshot; search: string; refresh: () => Promise<unknown>; onStart?: (id: string, title: string, start?: boolean) => void }) {
  const locale = useLocale(), de = () => locale().startsWith("de");
  const actions = createArtifactActions({ userId: props.snapshot.viewerUserId, refresh: props.refresh });
  const matches = (value: string) => value.toLocaleLowerCase().includes(props.search.toLocaleLowerCase());
  const status = (value: string) => ({ ready: de() ? "Erfolgreich" : "Succeeded", error: de() ? "Fehlgeschlagen" : "Failed", lost: de() ? "Verbindung verloren" : "Host lost", stopped: de() ? "Gestoppt" : "Stopped", unknown: de() ? "Unbekannt" : "Unknown" }[value] ?? (de() ? "In Arbeit" : "In progress"));
  const runs = () => props.snapshot.runs.filter(run => matches(status(run.status)) || matches(run.createdAt));
  return <div class="flex flex-col gap-4">
    <Show when={actions.error()}><Placeholder state="error" title={actions.error()} /></Show>
    <div class="assistant-apps-grid"><For each={props.snapshot.apps.filter(app => matches(app.title))}>{app =>
      <StudioCard item={app} menu={actions.menu(app)} busy={actions.busy()} external onStart={() => props.onStart?.(app.id, app.title, true)} />
    }</For></div>
    <Show when={props.snapshot.runs.length}>
      <div class="min-w-0"><h3 class="mb-2 text-xs font-medium text-secondary">{de() ? "Letzte Einmalläufe" : "Recent one-off runs"} · {props.snapshot.runCount}</h3>
        <DataTable rows={runs()} getRowId={run => run.id} density="compact" ariaLabel={de() ? "Einmalläufe" : "One-off runs"}
          columns={[{ id: "time", header: de() ? "Zeitpunkt" : "Time", value: run => new Date(run.createdAt).toLocaleString(locale()) }, { id: "status", header: "Status", value: run => status(run.status) }]}
        />
        <Show when={props.snapshot.runCount > props.snapshot.runs.length}><p class="mt-2 text-xs text-secondary">{de() ? `Die letzten ${props.snapshot.runs.length} Läufe werden angezeigt.` : `Showing the latest ${props.snapshot.runs.length} runs.`}</p></Show>
      </div>
    </Show>
  </div>;
}
