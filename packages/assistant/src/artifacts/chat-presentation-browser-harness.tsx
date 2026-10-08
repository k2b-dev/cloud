import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { ChatPresentation } from "./ChatPresentation";

declare global {
  var openedApps: string[];
}
globalThis.openedApps = [];
const params = new URLSearchParams(location.search);
function Harness() {
  const [visible, setVisible] = createSignal(true);
  return (
    <>
      <button type="button" onClick={() => setVisible(false)}>
        Leave chat
      </button>
      <Show when={visible()}>
        <ChatPresentation
          result={{ presentationId: params.get("presentation") ?? "00000000-0000-4000-8000-000000000001", title: "Inventory" }}
          conversationId="abc234"
          httpHost={{ approve: async () => false }}
          openApp={(id, title) => globalThis.openedApps.push(`${id}:${title}`)}
        />
      </Show>
    </>
  );
}
render(() => <Harness />, document.getElementById("root")!);
