import { Button, NoticeCard, prompts } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { artifactClient } from "./client";
import { artifactMessages } from "./messages";
import { advancedMessages } from "./advanced-messages";
import type { ArtifactSummary } from "./service";

/** Both the menu and preview publish the exact reviewed saved revision. */
export async function publishArtifact(item: Pick<ArtifactSummary, "id" | "revision" | "publishedVersion">, locale: string) {
  const t = artifactMessages.resolve([locale]).t;
  const firstRelease = !item.publishedVersion && !(await artifactClient.versions(item.id)).items.length;
  const values = firstRelease ? { note: "Initial release" } : await prompts.form({ title: t.publish, confirmText: t.publish, fields: {
    note: { type: "text", label: t.changeNote, required: true, maxLength: 1000, multiline: true },
  } });
  if (!values) return false;
  await artifactClient.publish(item.id, item.revision, values.note);
  return true;
}

export function openPublicationInfo(input: { id: string; revision: number; published: boolean; version?: number | null; locale: string; unsavedChanges?: boolean; onPublished: () => Promise<void> }) {
  const t = artifactMessages.resolve([input.locale]).t;
  return prompts.dialog<void>(close => {
    const [busy, setBusy] = createSignal(false), [error, setError] = createSignal("");
    return <div class="flex flex-col gap-4">
      <p>{input.published ? t.publishedPreviewHelp : t.draftPreviewHelp}</p>
      <NoticeCard tone="info" title={t.publishAccessTitle} detail={t.publishAccessHelp} />
      <Show when={!input.published && input.unsavedChanges}><NoticeCard tone="warning" title={advancedMessages.resolve([input.locale]).t.saveBeforePublish} /></Show>
      <Show when={error()}><NoticeCard tone="danger" title={error()} /></Show>
      <Show when={!input.published}><div class="flex justify-end"><Button loading={busy()} disabled={busy() || input.unsavedChanges} onClick={async () => {
        if (busy() || input.unsavedChanges) return;
        setBusy(true); setError("");
        try {
          if (await publishArtifact({ id: input.id, revision: input.revision, publishedVersion: input.version }, input.locale)) {
            await input.onPublished(); close();
          }
        } catch (failure) { setError(failure instanceof Error ? failure.message : t.REQUEST_FAILED); }
        finally { setBusy(false); }
      }}>{t.publish}</Button></div></Show>
    </div>;
  }, { title: input.published ? t.published : t.draft, size: "small" });
}
