import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, ButtonLink, CopyButton, dialogCore, NoticeCard, PanelDialog, panelDialogOptions, prompts, TextInput } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { DocumentLinkTtl } from "../../../contracts";
import { errorMessage } from "../utils/api-helpers";
import type { PublicCreateDocumentLinkResponse, PublicDocumentLink, PublicDocument } from "./public-document-types";

type DocumentLinkDialogArgs = {
  document: PublicDocument;
  onCreated: (link: PublicDocumentLink) => void | Promise<void>;
};

const ttlOptions: Array<{ value: DocumentLinkTtl; label: string; description: string }> = [
  { value: "1d", label: "1 day", description: "Short handoff" },
  { value: "7d", label: "7 days", description: "One week" },
  { value: "30d", label: "30 days", description: "Default" },
  { value: "90d", label: "90 days", description: "Long running" },
];

const absoluteUrl = (url: string): string => {
  if (typeof window === "undefined") return url;
  return new URL(url, window.location.origin).toString();
};

export const openDocumentLinkDialog = (args: DocumentLinkDialogArgs) =>
  dialogCore.open<void>((close) => <DocumentLinkDialog args={args} close={close} />, panelDialogOptions);

function DocumentLinkDialog(props: { args: DocumentLinkDialogArgs; close: () => void }) {
  const optionRefs: HTMLButtonElement[] = [];
  const [expiresIn, setExpiresIn] = createSignal<DocumentLinkTtl>("30d");
  const [comment, setComment] = createSignal("");
  const [createdUrl, setCreatedUrl] = createSignal<string | null>(null);
  const [copiedOnCreate, setCopiedOnCreate] = createSignal(false);
  const createMut = mutations.create<PublicCreateDocumentLinkResponse, void>({
    mutation: async () => {
      const res = await apiClient.documents[":documentId"].links.$post({
        param: { documentId: props.args.document.id },
        json: { expiresIn: expiresIn(), comment: comment().trim() || null },
      });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not create document link"));
      return res.json();
    },
    onSuccess: async (created) => {
      const url = absoluteUrl(created.url);
      let copied = false;
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch {
        // The visible copy button below is the fallback for locked-down browsers.
      }
      setCopiedOnCreate(copied);
      setCreatedUrl(url);
      await props.args.onCreated(created.link);
    },
    onError: (error) => prompts.error(error.message),
  });

  const selectOption = (index: number) => {
    const option = ttlOptions[index];
    if (!option) return;
    setExpiresIn(option.value);
    queueMicrotask(() => optionRefs[index]?.focus());
  };

  const onOptionKeyDown = (event: KeyboardEvent, index: number) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      selectOption((index + 1) % ttlOptions.length);
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      selectOption((index - 1 + ttlOptions.length) % ttlOptions.length);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      selectOption(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      selectOption(ttlOptions.length - 1);
    }
  };

  return (
    <PanelDialog>
      <PanelDialog.Header title="Create public link" subtitle={props.args.document.filename} icon="ti ti-link" close={props.close} />
      <PanelDialog.Body>
        <Show
          when={createdUrl()}
          fallback={
            <section class="flex flex-col gap-3">
              <div>
                <p class="text-sm font-medium text-primary">Validity</p>
                <div class="mt-2 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Public link validity">
                  <For each={ttlOptions}>
                    {(option, index) => (
                      <button
                        ref={(element) => {
                          optionRefs[index()] = element;
                        }}
                        type="button"
                        role="radio"
                        aria-checked={expiresIn() === option.value}
                        tabIndex={expiresIn() === option.value ? 0 : -1}
                        class={`rounded-[var(--ui-radius-control)] border px-3 py-2 text-left transition-colors ${
                          expiresIn() === option.value
                            ? "app-accent-border app-accent-text bg-[var(--ui-selected)]"
                            : "border-[var(--ui-border)] bg-[var(--ui-surface)] text-secondary hover:bg-[var(--ui-hover)] hover:text-primary"
                        }`}
                        onClick={() => setExpiresIn(option.value)}
                        onKeyDown={(event) => onOptionKeyDown(event, index())}
                      >
                        <span class="block text-sm font-medium">{option.label}</span>
                        <span class="block text-xs text-dimmed">{option.description}</span>
                      </button>
                    )}
                  </For>
                </div>
              </div>
              <TextInput
                label="Comment"
                description="Optional internal note. It is not visible to people using the link."
                value={comment}
                onValueChange={setComment}
                icon="ti ti-message"
                placeholder="Why this link exists"
              />
              <NoticeCard
                tone="info"
                title="Anyone with the link can download this PDF"
                detail="The link works without login until it expires or you revoke it. It does not provide access to other documents."
              />
            </section>
          }
        >
          {(url) => (
            <section class="flex flex-col gap-3">
              <NoticeCard
                tone="success"
                title={copiedOnCreate() ? "Link created and copied" : "Link created"}
                detail={copiedOnCreate() ? "You can paste it wherever you want to share the PDF." : "Use Copy link to copy the URL."}
              />
              <code class="block break-all rounded-[var(--ui-radius-control)] bg-[var(--ui-field)] p-2 font-mono text-xs text-secondary">
                {url()}
              </code>
              <div class="flex flex-wrap items-center gap-2">
                <CopyButton text={url()} label="Copy link" variant="secondary" size="sm" />
                <ButtonLink variant="secondary" size="sm" href={url()} target="_blank" rel="noreferrer">
                  <i class="ti ti-external-link" />
                  Open link
                </ButtonLink>
              </div>
            </section>
          )}
        </Show>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <span />
        <div class="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" type="button" onClick={props.close} disabled={createMut.loading()}>
            {createdUrl() ? "Done" : "Cancel"}
          </Button>
          <Show when={!createdUrl()}>
            <Button variant="primary" size="sm" type="button" onClick={() => createMut.mutate(undefined)} disabled={createMut.loading()}>
              {createMut.loading() ? <i class="ti ti-loader-2 animate-spin" /> : <i class="ti ti-link-plus" />}
              Create link
            </Button>
          </Show>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}
