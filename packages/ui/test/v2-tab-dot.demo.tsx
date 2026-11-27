import { createSignal } from "solid-js";
import { Pane, Tabs, Text, Workspace } from "../src/v2";
import type { Status } from "../src/v2/types";

// The areas of an infrastructure record as tabs, each with the state of what it opens: Postgres needs a look, Valkey is
// in order, NATS has no state. `window.__setPostgres` changes Postgres's state as a refresh would.

declare global {
  interface Window {
    __setPostgres?: (status: Status) => void;
  }
}

export function Demo() {
  const [postgres, setPostgres] = createSignal<Status>("warn");
  if (typeof window !== "undefined") window.__setPostgres = setPostgres;
  return (
    <Workspace
      head={
        <Tabs
          label="Infrastruktur"
          items={[
            { label: "Postgres", icon: "database", dot: postgres(), current: true, href: "#postgres" },
            { label: "Valkey", icon: "database", dot: "ok", href: "#valkey" },
            { label: "NATS", icon: "topology-star-3", href: "#nats" },
          ]}
        />
      }
    >
      <Pane label="Postgres">
        <Text>Postgres</Text>
      </Pane>
    </Workspace>
  );
}
