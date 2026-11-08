import { installPageSwap, swapPage } from "@k2b/ssr/nav";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { allowsLeave } from "../../ssr/src/nav-veto";
import { Button } from "../src/actions/Button";
import { ImageEditor } from "../src/inputs/ImageEditor";
import type { ImageEditorFeatures, ImageEditorFormat, ImageEditorResult } from "../src/inputs/image-editor/types";

const parameters = new URLSearchParams(location.search);
document.documentElement.lang = parameters.get("locale") === "de" ? "de" : "en";
if (parameters.has("nav")) {
  installPageSwap();
}
document.body.dataset.theme = parameters.has("dark") ? "dark" : "light";
const features: ImageEditorFeatures = parameters.has("minimal")
  ? { crop: { aspects: [parameters.has("wide") ? "16:9" : "1:1"], locked: true }, rotate: true }
  : {
      crop: true,
      rotate: true,
      straighten: true,
      adjust: true,
      filters: true,
      annotate: true,
      redact: true,
      export: { formats: parameters.has("pngOnly") ? ["image/png"] : undefined, quality: true, resize: true },
    };
const control = {
  mode: parameters.get("failure") ? "reject" : "success",
  attempts: 0,
  cancellations: 0,
  leave: () => {
    const restore = allowsLeave(document.body, new URL("/?destination=1", location.href));
    restore?.();
    return !!restore;
  },
  results: [] as ImageEditorResult[],
  selected: [] as string[],
  formats: (): readonly ImageEditorFormat[] => [],
  accept: () => {},
  source: (_source: string) => {},
  dispose: () => {},
};
Object.assign(window, { editorFixture: control });
function mount() {
  control.dispose = render(() => {
    const [source, setSource] = createSignal(parameters.has("broken") ? "/not-an-image.jpg" : "/photo.jpg");
    const [current, setCurrent] = createSignal("b");
    control.source = setSource;
    const items = parameters.has("items")
      ? ["a", "b", "c", "d"].map((id) => ({ id, name: `${id}.jpg`, thumbnail: id === "c" ? undefined : "/photo.jpg", dirty: id === "a" }))
      : undefined;
    const first = (
      <ImageEditor
        source={source()}
        title="photo.jpg"
        redactionNotice={parameters.has("redactionNotice") ? "Older versions keep the original." : undefined}
        facts={
          parameters.has("facts")
            ? [{ label: "Read only", icon: "ti ti-lock", tooltip: "You may only view this file" }, { label: "Version 3" }]
            : undefined
        }
        items={items}
        currentItem={current()}
        onSelectItem={(id) => {
          control.selected.push(id);
          setCurrent(id);
        }}
        features={features}
        saveActions={
          parameters.has("actions")
            ? (actions) => {
                control.formats = () => actions.formats;
                return (
                  <Button
                    disabled={actions.busy}
                    onClick={() =>
                      void actions.save(async (result) => {
                        control.results.push(result);
                      })
                    }
                  >
                    Done
                  </Button>
                );
              }
            : undefined
        }
        onCancel={() => {
          control.cancellations++;
        }}
        onSave={async (result) => {
          control.attempts++;
          if (control.mode === "reject") throw new Error("Upload unavailable. Retry to keep your edits.");
          if (control.mode === "pending")
            await new Promise<void>((resolve) => {
              control.accept = resolve;
            });
          control.results.push(result);
        }}
      />
    );
    // Two editors on one page guard the same navigation, as several open photos do in Tools and Files.
    return parameters.has("pair") ? (
      <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", height: "100%" }}>
        {first}
        <ImageEditor source="/photo.jpg" title="second.jpg" features={features} onSave={async () => {}} />
      </div>
    ) : (
      first
    );
  }, document.getElementById("editor")!);
}
if (parameters.has("nav")) void swapPage("/editing?nav=1").then(mount);
else mount();
