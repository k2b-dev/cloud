import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { BlockTree } from "./BlockTree";
import { blockScenes, imageStateScenes } from "./blocks.fixtures";

/** One result scene drawn in the browser, as a conversation draws it after its first frame: tables load their code. */
const params = new URLSearchParams(location.search);
const name = params.get("scene");
const host = params.get("host") === "preview" ? "preview" : "result";
const scene = [...blockScenes, ...imageStateScenes].find((entry) => entry.name === name);
if (!scene) throw new Error(`Unknown scene ${name}`);
const main = document.querySelector("main")!;
render(
  () => (
    <LocaleProvider locale="de">
      <BlockTree blocks={scene.blocks} host={host} locale="de" timeZone="Europe/Berlin" choice={scene.choice} />
    </LocaleProvider>
  ),
  main,
);
