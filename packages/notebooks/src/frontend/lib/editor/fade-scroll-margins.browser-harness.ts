import { defaultKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { ScrollArea } from "@k2b/ui";
import { createComponent, render } from "solid-js/web";
import { fadeScrollMarginsExtension, fadeScrollPadding } from "./fade-scroll-margins";

// The note editor's arrangement: CodeMirror grows inside a fading ScrollArea.
// The test overrides the fade size to a fake overlay height.
const params = new URLSearchParams(location.search);
const fade = params.get("fade") ?? "48px";
const margins = params.get("margins") !== "off";

let port: HTMLDivElement | undefined;
const host = document.createElement("div");
const root = document.getElementById("root")!;
render(
  () =>
    createComponent(ScrollArea, {
      ref: (element: HTMLDivElement) => {
        port = element;
      },
      style: { height: "320px", "--scroll-fade-size": fade, "scroll-padding-block": fadeScrollPadding },
      children: host,
    }),
  root,
);

const doc = Array.from({ length: 60 }, (_, index) => `Line ${index + 1} of the demo note`).join("\n");
const view = new EditorView({
  parent: host,
  state: EditorState.create({
    doc,
    extensions: [
      margins ? fadeScrollMarginsExtension(() => port) : [],
      keymap.of(defaultKeymap),
      EditorView.theme({ ".cm-editor": { minHeight: "100%" }, ".cm-scroller": { padding: "1rem" } }),
    ],
  }),
});

/** Where the cursor line sits relative to the fades that are drawn right now. */
const cursor = () => {
  const head = view.state.selection.main.head;
  const coords = view.coordsAtPos(head)!;
  const rect = port!.getBoundingClientRect();
  const edges = port!.getAttribute("data-scroll-fade") ?? "";
  const style = getComputedStyle(port!);
  return {
    clearBelow: rect.bottom - coords.bottom,
    clearAbove: coords.top - rect.top,
    bottomFade: edges === "bottom" || edges === "both" ? Number.parseFloat(style.getPropertyValue("--scroll-fade-bottom")) : 0,
    topFade: edges === "top" || edges === "both" ? Number.parseFloat(style.getPropertyValue("--scroll-fade-top")) : 0,
    scrollTop: port!.scrollTop,
    maxScrollTop: port!.scrollHeight - port!.clientHeight,
  };
};

/** Puts the cursor at the end of the last line that is fully visible above the bottom fade. */
const placeAtVisibleBottom = () => {
  const rect = port!.getBoundingClientRect();
  const pos = view.posAtCoords({ x: rect.left + 40, y: rect.bottom - Number.parseFloat(fade) - 24 })!;
  const line = view.state.doc.lineAt(pos);
  view.dispatch({ selection: { anchor: line.to } });
  view.focus();
};

const placeAtEnd = () => {
  view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
  view.focus();
};

const paste = (text: string) => {
  const data = new DataTransfer();
  data.setData("text/plain", text);
  view.contentDOM.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
};

const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

Object.assign(window, { harness: { cursor, placeAtVisibleBottom, placeAtEnd, paste, settle } });
