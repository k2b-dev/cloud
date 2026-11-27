import { render } from "solid-js/web";
import { Notice, Pane, Text, Workspace } from "../src/v2";

// The offline notice of a Cloud page (PS PWA): "Neu laden" is the one thing to do, "Später" waits quietly. The page
// has its own primary action, which stays the one primary of the page.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    __k2Deeds?: string[];
  }
}

const did = (deed: string) => () => {
  window.__k2Deeds = [...(window.__k2Deeds ?? []), deed];
};

const root = document.getElementById("root");
if (!root) throw new Error("notice primary: #root is missing");
render(
  () => (
    <Workspace primary={{ label: "Neu", icon: "plus", onClick: did("new") }}>
      <Pane label="Liste">
        <Notice
          tone="warn"
          title="Offline"
          primary={{ label: "Neu laden", onClick: did("reload") }}
          actions={[{ label: "Später", onClick: did("later") }]}
        >
          Die Seite ist nicht mehr verbunden. Neue Einträge erscheinen erst nach dem Neuladen.
        </Notice>
        <Text>Eintrag</Text>
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
