import { render } from "solid-js/web";
import { Pane, Text, Tiles, Workspace } from "../src/v2";

// A first start without any data (W2 Notebooks, W4 Grids): no sidebar, one line and four ways to start in the middle
// of the page. `data-tiles="n"` on the body asks for n tiles, so a test can make the content taller than the page;
// `data-variant="card"` asks for cards.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("pane center: #root is missing");
const count = Number(document.body.dataset.tiles ?? "4");
const card = document.body.dataset.variant === "card";
const names = ["Leeres Notizbuch", "Tagebuch", "Rezepte und Vorräte", "Leseliste"];
render(
  () => (
    <Workspace>
      <Pane label="Notizbücher" center>
        <Text type="lead">Womit soll dein erstes Notizbuch beginnen?</Text>
        <Tiles
          label="Wege zum Start"
          perRow={4}
          variant={card ? "card" : undefined}
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
