import { useLocale } from "@k2b/ui";
import { type Accessor, type JSX, Match, Switch } from "solid-js";
import { notebookWorkspaceMessages } from "../../[id]/messages";
import { MermaidViewport } from "../mermaid-viewport";

export type MermaidPreviewState = { kind: "loading" } | { kind: "ready"; svg: string } | { kind: "error"; message: string };

/** Parse rendered Mermaid markup into a fresh element that fits its box without overflowing. */
const diagramElement = (markup: string): JSX.Element => {
  const host = document.createElement("div");
  host.innerHTML = markup;
  const svg = host.querySelector("svg");
  if (!svg) return host;
  svg.style.maxWidth = "90%";
  svg.style.maxHeight = "90%";
  svg.style.width = "auto";
  svg.style.height = "auto";
  return svg;
};

/** Editor preview of one Mermaid block: loading, the zoomable diagram, or the syntax error. */
export function MermaidEditorPreview(props: {
  state: Accessor<MermaidPreviewState>;
  title: () => string | null;
  exportSvg: () => Promise<string>;
}): JSX.Element {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const svg = () => {
    const state = props.state();
    return state.kind === "ready" ? state.svg : undefined;
  };
  const error = () => {
    const state = props.state();
    return state.kind === "error" ? state.message : undefined;
  };
  return (
    <Switch
      fallback={
        <div class="flex h-full items-center justify-center gap-2 p-4 text-gray-500">
          <i class="ti ti-loader animate-spin" aria-hidden="true" />
          <span class="text-sm">{t().loadingDiagram}</span>
        </div>
      }
    >
      <Match when={svg()}>
        {(markup) => (
          <MermaidViewport
            class="h-full w-full"
            controls="hover"
            diagram={() => diagramElement(markup())}
            title={props.title()}
            exportSvg={props.exportSvg}
          />
        )}
      </Match>
      <Match when={error()}>
        {(message) => (
          <div class="flex h-full flex-col items-center justify-center gap-2 p-4 text-red-500">
            <i class="ti ti-alert-circle text-2xl" aria-hidden="true" />
            <span class="text-sm font-mono">{t().invalidMermaid}</span>
            <details class="text-xs text-gray-500 max-w-full">
              <summary class="cursor-pointer hover:text-gray-700 dark:hover:text-gray-300">{t().showErrorDetails}</summary>
              <pre class="mt-2 p-2 bg-gray-100 dark:bg-gray-800 rounded text-left overflow-x-auto">{message()}</pre>
            </details>
          </div>
        )}
      </Match>
    </Switch>
  );
}
