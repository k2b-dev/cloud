import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { ChatPresentation } from "./ChatPresentation";

function Harness() {
  const [visible, setVisible] = createSignal(true);
  return (
    <>
      <button onClick={() => setVisible(false)}>Leave chat</button>
      <Show when={visible()}>
        <ChatPresentation
          result={{ presentationId: "00000000-0000-4000-8000-000000000001", title: "Inventory" }}
          conversationId="abc234"
          httpHost={{ approve: async () => false }}
        />
      </Show>
    </>
  );
}
render(() => <Harness />, document.getElementById("root")!);
