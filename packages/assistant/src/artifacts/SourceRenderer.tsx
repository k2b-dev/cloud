import { Button, CodeDisplay, useLocale, type FileViewRenderer, type FileViewRendererProps } from "@k2b/ui";
import { Show } from "solid-js";
import { artifactMessages } from "./messages";
import { SourceEditor } from "./SourceEditor";

function SourceRenderer(props: FileViewRendererProps) {
  const locale = useLocale(), t = () => artifactMessages.resolve([locale()]).t;
  return <Show when={props.editor} fallback={<CodeDisplay code={props.content.content} language="js" />}>
    {(editor) => <div class="artifact-source-editor">
      <div class="artifact-source-editor__actions">
        <Button size="sm" variant="ghost" loading={editor().saving()} disabled={!editor().dirty()}
          onClick={() => void editor().save()}>{t().save}</Button>
      </div>
      <SourceEditor path={props.file.path} content={editor().draft()} onChange={editor().setDraft}
        onSave={() => { if (editor().dirty() && !editor().saving()) void editor().save(); }} />
    </div>}
  </Show>;
}

export const artifactSourceRenderers: readonly FileViewRenderer[] = [{
  id: "assistant-source", editable: true,
  match: (file, content) => content.encoding === "utf8" && /\.(?:js|ts)$/.test(file.path),
  component: SourceRenderer,
}];
