import { isServer, render } from "solid-js/web";
import { Chat, ReferenceChip } from "../src/index";

export function ActivityToggleFixture() {
  return (
    <>
      <p id="above">Earlier conversation</p>
      <Chat.Activity
        icon="ti ti-check"
        tone="warning"
        label={
          <>
            <Chat.Activity.Toggle>3 of 4 tasks</Chat.Activity.Toggle> created in{" "}
            <ReferenceChip kind="place" title="Team Ops" href="#chip" />
          </>
        }
        renderBody={() => <p>Three tasks created. One needs another try.</p>}
      />
    </>
  );
}

// The visual cases use SSR. Mount the same fixture for real pointer and keyboard events.
if (!isServer) render(() => <ActivityToggleFixture />, document.getElementById("toggle-root")!);
