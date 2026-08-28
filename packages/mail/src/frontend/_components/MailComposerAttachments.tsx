import { text } from "@k2b/stdlib";
import { IconButton, useLocale } from "@k2b/ui";
import type { Accessor } from "solid-js";
import { For, Show } from "solid-js";
import type { MailDraft } from "../../contracts";
import { mailComposerMessages } from "./mail-composer-messages";
export type MailComposerUpload = {
  file: File;
  progress: number;
  error: string | null;
  uploadId: string | null;
  draftId: string | null;
};

export default function MailComposerAttachments(props: {
  attachments: Accessor<MailDraft["attachments"]>;
  uploads: Accessor<MailComposerUpload[]>;
  editable: Accessor<boolean>;
  canShare: boolean;
  shareLoading: Accessor<boolean>;
  onInsertLink: (attachmentId: string) => void;
  onRemove: (attachmentId: string) => void;
  onRetryUpload: (upload: MailComposerUpload) => void;
  onCancelUpload: (upload: MailComposerUpload) => void;
}) {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  return (
    <Show when={props.attachments().length > 0 || props.uploads().length > 0}>
      <div class="flex shrink-0 flex-wrap gap-2 py-2" aria-label={t().attachedFiles} role="list">
        <For each={props.attachments()}>
          {(attachment) => (
            <span class="chip max-w-full" role="listitem">
              <i class="ti ti-paperclip" aria-hidden="true" />
              <span class="max-w-48 truncate">{attachment.filename}</span>
              <span class="text-xs text-dimmed">{text.pprintBytes(attachment.byteLength)}</span>
              <Show when={props.canShare}>
                <IconButton
                  type="button"
                  label={t().insertPublicLink({ filename: attachment.filename })}
                  disabled={!props.editable() || props.shareLoading()}
                  onClick={() => props.onInsertLink(attachment.id)}
                >
                  <i class="ti ti-link" aria-hidden="true" />
                </IconButton>
              </Show>
              <IconButton
                type="button"
                label={t().removeFile({ filename: attachment.filename })}
                disabled={!props.editable()}
                onClick={() => props.onRemove(attachment.id)}
              >
                <i class="ti ti-x" aria-hidden="true" />
              </IconButton>
            </span>
          )}
        </For>
        <For each={props.uploads()}>
          {(upload) => (
            <span class="chip max-w-full" role="listitem">
              <i class={`ti ${upload.error ? "ti-alert-circle text-red-500" : "ti-loader-2 animate-spin"}`} aria-hidden="true" />
              <span class="max-w-48 truncate">{upload.file.name}</span>
              <span class="text-xs text-dimmed">{upload.error ?? `${upload.progress}%`}</span>
              <Show when={upload.error}>
                <IconButton
                  type="button"
                  label={t().retryFile({ filename: upload.file.name })}
                  disabled={!props.editable()}
                  onClick={() => props.onRetryUpload(upload)}
                >
                  <i class="ti ti-refresh" aria-hidden="true" />
                </IconButton>
              </Show>
              <IconButton
                type="button"
                label={t().cancelFile({ filename: upload.file.name })}
                disabled={!props.editable()}
                onClick={() => props.onCancelUpload(upload)}
              >
                <i class="ti ti-x" aria-hidden="true" />
              </IconButton>
            </span>
          )}
        </For>
      </div>
    </Show>
  );
}
