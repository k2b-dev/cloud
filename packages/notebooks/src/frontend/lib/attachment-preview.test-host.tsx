import { useLocale } from "@k2b/ui";
import { For } from "solid-js";
import type { Attachment } from "../[id]/_components/editor/attachments-client";
import { notebookWorkspaceMessages } from "../[id]/messages";
import { attachmentPreviewKind, openAttachment } from "./attachment-preview";

/**
 * A stand-in list for the preview tests: one button per attachment that opens it the way a row of the attachments page
 * does (`openAttachment` with the whole list), named by what the press does. The page's own rows are covered by its
 * browser test; these tests cover the preview itself.
 */
export default function PreviewTiles(props: { notebookId: string; attachments: Attachment[] }) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  return (
    <ul>
      <For each={props.attachments}>
        {(attachment) => (
          <li>
            <button
              type="button"
              class="notebooks-attachment-tile__open"
              aria-label={
                attachmentPreviewKind(attachment)
                  ? t().previewNamedAttachment({ filename: attachment.filename })
                  : t().downloadNamedAttachment({ filename: attachment.filename })
              }
              onClick={() => openAttachment(props.notebookId, attachment, props.attachments)}
            >
              {attachment.filename}
            </button>
          </li>
        )}
      </For>
    </ul>
  );
}
