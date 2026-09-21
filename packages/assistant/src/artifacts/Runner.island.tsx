import { createSignal } from "solid-js";
import { ArtifactPanel } from "./ArtifactPanel";
import { RunnerActions } from "./RunnerActions";
import type { RunnerMetadata } from "./runner-contracts";

export default function Runner(props: { initial: RunnerMetadata; userId: string }) {
  const [metadata, setMetadata] = createSignal(props.initial);
  return (
    <section aria-label={metadata().title} class="assistant-standalone-runner">
      <ArtifactPanel
        artifactId={props.initial.id}
        userId={props.userId}
        runner={props.initial}
        onRunnerMetadata={setMetadata}
        autoStart
        actions={
          <RunnerActions
            id={props.initial.id}
            userId={props.userId}
            serverAccess={metadata().serverAccess}
            canManage={metadata().canManage}
          />
        }
      />
    </section>
  );
}
