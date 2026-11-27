import { render } from "solid-js/web";
import { Pane, Text, Tiles, Workspace } from "../src/v2";

// A first start without any data (W2 Notebooks, W4 Grids): no sidebar, one line and four ways to start in the middle
// of the page. `?tiles=n` asks for n tiles, so a test can make the content taller than the page.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("pane center: #root is missing");
const count = Number(new URLSearchParams(window.location.search).get("tiles") ?? document.body.dataset.tiles ?? "4");
const names = ["Leeres Notizbuch", "Tagebuch", "Rezepte und Vorräte", "Leseliste"];
render(
  () => (
    <Workspace>
      <Pane label="Notizbücher" center>
        <Text type="lead">Womit soll dein erstes Notizbuch beginnen?</Text>
        <Tiles
          label="Wege zum Start"
          perRow={4}
          items={Array.from({ length: count }, (_, index) => ({
            icon: "notebook",
            title: names[index % names.length] ?? "Notizbuch",
            meta: `${index + 1} Seiten`,
            href: `/app/notebooks?new=${index}`,
          }))}
        />
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
