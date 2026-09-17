import { ButtonLink, useLocale } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import type { RunnerMetadata } from "./runner-contracts";
import { ArtifactPanel } from "./ArtifactPanel";
import { artifactMessages } from "./messages";
import { RunnerActions } from "./RunnerActions";

export default function Runner(props: { initial: RunnerMetadata; userId: string }) {
  const locale = useLocale(), t = () => artifactMessages.resolve([locale()]).t;
  const [metadata, setMetadata] = createSignal(props.initial);
  return <section aria-label={metadata().title} class="p-4 flex flex-col gap-4 min-w-0 flex-1">
    <header class="flex items-center justify-between gap-3">
      <h1 class="text-xl font-semibold flex items-center gap-2"><i class={metadata().icon ?? "ti ti-app-window"} aria-hidden="true" />{metadata().title}</h1>
      <div class="flex items-center gap-2">
        <Show when={metadata().canManage}><ButtonLink href={`/app/assistant/apps/${props.initial.id}`} variant="ghost"><i class="ti ti-settings" aria-hidden="true" />{t().manage}</ButtonLink></Show>
        <RunnerActions id={props.initial.id} userId={props.userId} serverAccess={metadata().serverAccess} />
      </div>
    </header>
    <ArtifactPanel artifactId={props.initial.id} userId={props.userId} runner={props.initial} onRunnerMetadata={setMetadata} autoStart />
  </section>;
}
