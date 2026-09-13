import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { createArtifactSession, type RunSnapshot } from "./runtime/session";
import { RuntimeView } from "./RuntimeView";

function Harness() {
  const [state, setState] = createSignal<RunSnapshot>();
  const [error, setError] = createSignal("");
  let session: ReturnType<typeof createArtifactSession>;
  fetch("/source")
    .then((response) => response.json())
    .then((source) => {
      session = createArtifactSession(document.body, source, { mode: "test", changed: setState });
    });
  return (
    <>
      <RuntimeView
        nodes={state()?.nodes ?? []}
        busy={state()?.busy ?? false}
        event={(event) => {
          void session.event(event).catch((error) => setError(String(error)));
        }}
      />
      <output id="state">{state()?.status}</output>
      <output id="errors">{error() || state()?.error}</output>
    </>
  );
}
render(() => <Harness />, document.getElementById("root")!);
