import { createSignal } from "solid-js";
import { Tabs } from "../../src/v2";

/**
 * The displays of a graph (W2, Notebooks): on a wide screen it opens on its network, on the phone on its list, until
 * the person picks one. The server does not know the width, so both are marked in its page.
 */
export function Demo() {
  const [picked, setPicked] = createSignal<string>();
  return (
    <div class="k2-ui">
      <Tabs
        label="Ansicht"
        items={[
          { label: "Netz", icon: "affiliate", defaultOn: "wide", current: picked() === "net", onClick: () => setPicked("net") },
          { label: "Liste", icon: "list", defaultOn: "phone", current: picked() === "list", onClick: () => setPicked("list") },
          { label: "Zeitleiste", icon: "timeline", current: picked() === "time", onClick: () => setPicked("time") },
        ]}
      />
    </div>
  );
}
