import {
  Button,
  CodeDisplay,
  type CodeDisplayLanguage,
  type FileViewRenderer,
  type FileViewRendererProps,
  getFileViewPreviewKind,
  useLocale,
} from "@k2b/ui";
import { Show } from "solid-js";
import { artifactMessages } from "./messages";
import { SourceEditor } from "./SourceEditor";

/** Highlights read-only source the way the FileView text preview does: by the file's extension. */
const sourceLanguage = (path: string): CodeDisplayLanguage => {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "ts" || extension === "mts" || extension === "cts") return "ts";
  if (extension === "tsx") return "tsx";
  if (extension === "js" || extension === "mjs" || extension === "cjs") return "js";
  if (extension === "jsx") return "jsx";
  return "text";
};

function SourceRenderer(props: FileViewRendererProps) {
  const locale = useLocale(),
    t = () => artifactMessages.resolve([locale()]).t;
  return (
    <Show when={props.editor} fallback={<CodeDisplay code={props.content.content} language={sourceLanguage(props.file.path)} />}>
      {(editor) => (
        <div class="artifact-source-editor">
          <div class="artifact-source-editor__actions">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const url = URL.createObjectURL(new Blob([editor().draft()], { type: "text/plain" }));
                const link = document.createElement("a");
                link.href = url;
                link.download = props.file.path.split("/").at(-1) ?? "draft.txt";
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              {t().downloadDraft}
            </Button>
            <Button size="sm" variant="ghost" loading={editor().saving()} disabled={!editor().dirty()} onClick={() => void editor().save()}>
              {t().save}
            </Button>
          </div>
          <SourceEditor
            path={props.file.path}
            content={editor().draft()}
            onChange={editor().setDraft}
            onSave={() => {
              if (editor().dirty() && !editor().saving()) void editor().save();
            }}
          />
        </div>
      )}
    </Show>
  );
}

export const artifactSourceRenderers: readonly FileViewRenderer[] = [
  {
    id: "assistant-source",
    editable: true,
    match: (file, content) => content.encoding === "utf8" && /\.(?:js|ts)$/.test(file.path),
    component: SourceRenderer,
  },
];

/**
 * A plain preview shows text without the code box that carries its copy action. Read-only source text keeps that
 * action here, because a workspace tab has no header to hold it. Editable files use the editor instead.
 */
export const readOnlySourceRenderers: readonly FileViewRenderer[] = [
  ...artifactSourceRenderers,
  {
    id: "assistant-source-text",
    match: (file, content) =>
      content.encoding === "utf8" && getFileViewPreviewKind({ path: file.path, mediaType: content.mediaType }) === "text",
    component: (props) => <CodeDisplay code={props.content.content} language={sourceLanguage(props.file.path)} />,
  },
];
