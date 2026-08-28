import { mutation as mutations } from "@k2b/stdlib/solid";
import { prompts, toast } from "@k2b/ui";
import type { Accessor, Setter } from "solid-js";
import { createSignal, onCleanup } from "solid-js";
import { apiClient } from "../../api/client";
import type { CreateAttachmentLinkInput, CreatedAttachmentLink, DraftAttachment, MailDraft } from "../../contracts";
import { readApiError } from "./api-response";
import { promptAttachmentLinkOptions } from "./attachment-link-ui";
import type { MailComposerUpload } from "./MailComposerAttachments";
import { mailComposerMessages } from "./mail-composer-messages";
import type { createMailComposerTransition } from "./mail-composer-transition";

export const createMailComposerAttachmentManager = (options: {
  mailboxId: string;
  draft: Accessor<MailDraft | null>;
  initialAttachments: Accessor<DraftAttachment[]>;
  setDraft: Setter<MailDraft | null>;
  editable: Accessor<boolean>;
  persist: () => Promise<MailDraft | null>;
  serializeDraftMutation: <T>(operation: () => Promise<T>) => Promise<T>;
  transition: ReturnType<typeof createMailComposerTransition>;
  format: Accessor<"plain" | "markdown">;
  setBody: Setter<string>;
  isDisposed: () => boolean;
  locale: Accessor<string>;
}) => {
  const t = () => mailComposerMessages.resolve([options.locale()]).t;
  const [uploads, setUploads] = createSignal<MailComposerUpload[]>([]);
  const uploadControllers = new Map<File, AbortController>();
  const materializedAttachmentId = (requestedId: string, currentDraft: MailDraft): string => {
    const initial = options.initialAttachments().find((attachment) => attachment.id === requestedId);
    if (!initial) return requestedId;
    return (
      currentDraft.attachments.find(
        (attachment) =>
          attachment.contentHash === initial.contentHash &&
          attachment.position === initial.position &&
          attachment.filename === initial.filename,
      )?.id ?? requestedId
    );
  };

  const uploadFile = async (file: File) => {
    const controller = new AbortController();
    uploadControllers.get(file)?.abort();
    uploadControllers.set(file, controller);
    setUploads((current) => [
      ...current.filter((entry) => entry.file !== file),
      { file, progress: 0, error: null, uploadId: null, draftId: null },
    ]);
    try {
      const saved = await options.persist();
      if (!saved) throw new Error(t().saveBeforeAttach);
      const createResponse = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"]["attachment-uploads"].$post(
        {
          param: { mailboxId: options.mailboxId, draftId: saved.id },
          json: { filename: file.name, contentType: file.type || "application/octet-stream", byteLength: file.size },
        },
        { init: { signal: controller.signal } },
      );
      if (!createResponse.ok) throw new Error(await readApiError(createResponse, t().attachFileFailed({ filename: file.name })));
      const upload = await createResponse.json();
      setUploads((current) => current.map((entry) => (entry.file === file ? { ...entry, uploadId: upload.id, draftId: saved.id } : entry)));
      for (let offset = 0; offset < file.size; offset += upload.chunkSize) {
        const chunk = file.slice(offset, Math.min(file.size, offset + upload.chunkSize));
        const response = await fetch(
          `/api/mail/mailboxes/${options.mailboxId}/drafts/${saved.id}/attachment-uploads/${upload.id}?offset=${offset}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/octet-stream" },
            body: chunk,
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error(await readApiError(response, t().uploadFileFailed({ filename: file.name })));
        const progress = file.size === 0 ? 100 : Math.round((Math.min(file.size, offset + chunk.size) / file.size) * 100);
        setUploads((current) => current.map((entry) => (entry.file === file ? { ...entry, progress } : entry)));
      }
      await options.serializeDraftMutation(async () => {
        const latest = options.draft() ?? saved;
        const finalizeResponse = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"]["attachment-uploads"][
          ":uploadId"
        ].finalize.$post(
          {
            param: { mailboxId: options.mailboxId, draftId: saved.id, uploadId: upload.id },
            json: { expectedRevision: latest.revision },
          },
          { init: { signal: controller.signal } },
        );
        if (!finalizeResponse.ok) throw new Error(await readApiError(finalizeResponse, t().finalizeFileFailed({ filename: file.name })));
        options.setDraft(await finalizeResponse.json());
      });
      setUploads((current) => current.filter((entry) => entry.file !== file));
    } finally {
      if (uploadControllers.get(file) === controller) uploadControllers.delete(file);
    }
  };

  const cancelUpload = async (upload: MailComposerUpload) => {
    uploadControllers.get(upload.file)?.abort();
    uploadControllers.delete(upload.file);
    if (upload.uploadId && upload.draftId) {
      const response = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"]["attachment-uploads"][":uploadId"].$delete({
        param: { mailboxId: options.mailboxId, draftId: upload.draftId, uploadId: upload.uploadId },
      });
      if (!response.ok) throw new Error(await readApiError(response, t().cancelUploadFailed({ filename: upload.file.name })));
    }
    setUploads((current) => current.filter((entry) => entry.file !== upload.file));
  };

  const retryUpload = async (upload: MailComposerUpload) => {
    try {
      await cancelUpload(upload);
      await uploadFile(upload.file);
    } catch (error) {
      await prompts.error(error instanceof Error ? error.message : t().retryUploadFailed({ filename: upload.file.name }));
    }
  };

  const addFiles = async (files: File[]) => {
    for (const file of files) {
      try {
        await uploadFile(file);
      } catch (error) {
        if (options.isDisposed() || (error instanceof DOMException && error.name === "AbortError")) return;
        setUploads((current) =>
          current.map((entry) =>
            entry.file === file ? { ...entry, error: error instanceof Error ? error.message : t().uploadFailed } : entry,
          ),
        );
      }
    }
  };

  const removeAttachment = async (attachmentId: string) => {
    if (!options.editable()) return;
    const reservation = options.transition.reserve("attachment");
    if (!reservation) return;
    try {
      const saved = options.draft() ?? (await options.persist());
      if (!saved) return;
      await options.serializeDraftMutation(async () => {
        const currentDraft = options.draft() ?? saved;
        const persistedAttachmentId = materializedAttachmentId(attachmentId, currentDraft);
        const response = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"].attachments[":attachmentId"].$delete({
          param: { mailboxId: options.mailboxId, draftId: currentDraft.id, attachmentId: persistedAttachmentId },
          query: { expectedRevision: String(currentDraft.revision) },
        });
        if (!response.ok) return await prompts.error(await readApiError(response, t().removeAttachmentFailed));
        options.setDraft(await response.json());
      });
    } finally {
      options.transition.release(reservation);
    }
  };

  const shareAttachment = mutations.create<CreatedAttachmentLink, { attachmentId: string; input: CreateAttachmentLinkInput }>({
    mutation: async ({ attachmentId, input }, { abortSignal }) => {
      const currentDraft = options.draft() ?? (await options.persist());
      if (!currentDraft) throw new Error(t().saveBeforeShare);
      const persistedAttachmentId = materializedAttachmentId(attachmentId, currentDraft);
      const response = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"].attachments[":attachmentId"].links.$post(
        {
          param: { mailboxId: options.mailboxId, draftId: currentDraft.id, attachmentId: persistedAttachmentId },
          json: input,
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().shareAttachmentFailed));
      return response.json();
    },
    onSuccess: ({ link, url }) => {
      const label = link.filename ?? t().downloadAttachment;
      const insertion = options.format() === "markdown" ? `[${label.replaceAll("]", "\\]")}](${url})` : url;
      options.setBody((current) => `${current}${current.endsWith("\n") || !current ? "" : "\n\n"}${insertion}`);
      toast.success(t().publicLinkInserted);
    },
    onError: (error) => prompts.error(error.message),
  });

  const insertAttachmentLink = async (attachmentId: string) => {
    if (!options.editable()) return;
    const reservation = options.transition.reserve("attachment");
    if (!reservation) return;
    try {
      const input = await promptAttachmentLinkOptions(options.locale());
      if (input && !options.isDisposed()) await shareAttachment.mutate({ attachmentId, input });
    } finally {
      options.transition.release(reservation);
    }
  };

  onCleanup(() => {
    for (const controller of uploadControllers.values()) controller.abort();
    uploadControllers.clear();
    shareAttachment.abort();
  });

  return {
    uploads,
    addFiles,
    cancelUpload,
    retryUpload,
    removeAttachment,
    insertAttachmentLink,
    shareLoading: shareAttachment.loading,
  };
};
