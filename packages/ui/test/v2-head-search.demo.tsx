import { createSignal } from "solid-js";
import { isServer } from "solid-js/web";
import { Bar, Button, Input, Pane, Text, Workspace } from "../src/v2";

// The head search of a list that the server filters, as the group list of Accounts has it: without JavaScript Enter
// loads the list's page with `q` and the rest of the address (the filter `level=error`); where JavaScript runs, the
// page searches in place and every search lands in `window.__searched`. `?_load` leaves out `onSearch`, so Enter
// loads the page also where JavaScript runs.

declare global {
  interface Window {
    __searched?: string[];
  }
}

export function Demo() {
  const load = !isServer && new URLSearchParams(location.search).has("_load");
  const [shown, setShown] = createSignal("");
  return (
    <Workspace
      head={
        <Bar
          start={<Text type="body">Gruppen</Text>}
          end={
            <>
              <Input
                type="search"
                icon="search"
                name="q"
                label="Gruppen durchsuchen"
                placeholder="Gruppen durchsuchen"
                value="Lager"
                send={{
                  action: "/gruppen",
                  // the rest of the address; the field's own `q` is left out
                  params: [
                    ["level", "error"],
                    ["q", "Lager"],
                  ],
                  onSearch: load
                    ? undefined
                    : (text) => {
                        window.__searched = [...(window.__searched ?? []), text];
                        setShown(text);
                      },
                }}
              />
              <Button keep variant="ghost" icon="dots" label="Weitere Aktionen" />
            </>
          }
        />
      }
    >
      <Pane label="Gruppen">
        <Text type="body">{shown() ? `Suche: ${shown()}` : "Alle Gruppen"}</Text>
      </Pane>
    </Workspace>
  );
}
