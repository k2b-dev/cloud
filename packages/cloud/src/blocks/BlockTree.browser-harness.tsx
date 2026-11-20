import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { BlockTree } from "./BlockTree";
import { blockScenes, imageEdgeScenes, imageFitScenes, imageLayoutScenes, imageStateScenes } from "./blocks.fixtures";
import { failedBeforeHydration } from "./picture";

/** One result scene drawn in the browser, as a conversation draws it after its first frame: tables load their code. */
const params = new URLSearchParams(location.search);
const name = params.get("scene");
const host = (["preview", "review"] as const).find((entry) => entry === params.get("host")) ?? "result";
const scene = [...blockScenes, ...imageStateScenes, ...imageLayoutScenes, ...imageFitScenes, ...imageEdgeScenes].find(
  (entry) => entry.name === name,
);
if (!scene) throw new Error(`Unknown scene ${name}`);
declare global {
  interface Window {
    /** The check a hydrated picture runs, for the test to ask about pictures the browser settled on its own. */
    failedBeforeHydration: typeof failedBeforeHydration;
  }
}
window.failedBeforeHydration = failedBeforeHydration;
const main = document.querySelector("main")!;
render(
  () => (
    <LocaleProvider locale="de">
      <BlockTree blocks={scene.blocks} host={host} locale="de" timeZone="Europe/Berlin" choice={scene.choice} />
    </LocaleProvider>
  ),
  main,
);
