import { render } from "solid-js/web";
import { Bar, Button, Input, Menu, Pane, Path, Text, Workspace } from "../src/v2";

// A head as the Assistant draws it, in the shapes a page has (src/v2/phone-head-actions.browser.test.ts): a chat, whose
// head holds where it stands, the search, its menu "…" and "Neuer Chat"; a list, whose head holds where it stands, the
// search and the main action that the workspace repeats as the floating button on the phone; a bare head without a
// start, only the search and the menu "…"; a list with an open detail (on the phone the detail is the page, and no
// main action floats over it); and a list whose head marks its main action `floats` but whose workspace has no `primary` ("nofab").

declare global {
  interface Window {
    __k2Mounted?: boolean;
    /** Set before the fixture mounts: the shape of the page. */
    __k2HeadKind?: "chat" | "list" | "bare" | "detail" | "nofab";
    /** What the head's search sent with Enter. */
    __k2Searched?: string;
    /** What the chat's menu opened. */
    __k2HeadOpened?: string;
  }
}

const kind = window.__k2HeadKind ?? "chat";

render(
  () => (
    <Workspace
      head={
        <Bar
          start={
            kind === "bare" ? undefined : (
              <Path label="Gustav" items={[{ label: kind === "chat" ? "Angebot Küche Lindqvist" : "Meine Apps & Automationen" }]} />
            )
          }
          end={
            <>
              <Input
                type="search"
                icon="search"
                label="Chats durchsuchen"
                placeholder="Chats durchsuchen"
                onKeyDown={(event) => {
                  if (event.key === "Enter") window.__k2Searched = (event.currentTarget as HTMLInputElement).value;
                }}
              />
              {kind === "chat" || kind === "bare" ? (
                <Menu
                  label="Aktionen des Chats"
                  items={[{ label: "In diesem Chat", icon: "layout-list", onClick: () => (window.__k2HeadOpened = "context") }]}
                />
              ) : null}
              {kind !== "bare" ? (
                <Button variant="primary" icon="plus" floats={kind === "list" || kind === "nofab"}>
                  Neuer Chat
                </Button>
              ) : null}
            </>
          }
        />
      }
      primary={kind === "list" ? { label: "Neuer Chat", icon: "plus" } : undefined}
    >
      {kind === "detail" ? (
        <Pane.Split>
          <Pane label="Liste" width={{ min: 280, default: 360 }}>
            <Text>Die Liste.</Text>
          </Pane>
          <Pane
            label="Angebot Küche Lindqvist"
            detail
            back={{ label: "Liste", href: "#liste" }}
            head={
              <Bar
                start={<Text>Angebot Küche Lindqvist</Text>}
                end={<Button variant="ghost" icon="x" label="Schließen" href="#liste" closes />}
              />
            }
          >
            <Text>Das offene Angebot.</Text>
          </Pane>
        </Pane.Split>
      ) : (
        <Pane label="Inhalt">
          <Text>Die erste Zeile des Inhalts.</Text>
        </Pane>
      )}
    </Workspace>
  ),
  document.getElementById("root")!,
);
window.__k2Mounted = true;
