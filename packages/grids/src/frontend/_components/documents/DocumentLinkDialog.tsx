import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  ButtonLink,
  CopyButton,
  dialogCore,
  NoticeCard,
  PanelDialog,
  panelDialogOptions,
  prompts,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { DocumentLinkTtl } from "../../../contracts";
import { errorMessage } from "../utils/api-helpers";
import { documentMessages } from "./messages";
import type { PublicCreateDocumentLinkResponse, PublicDocument, PublicDocumentLink } from "./public-document-types";

type DocumentLinkDialogArgs = {
  document: PublicDocument;
  onCreated: (link: PublicDocumentLink) => void | Promise<void>;
};

const absoluteUrl = (url: string): string => {
  if (typeof window === "undefined") return url;
  return new URL(url, window.location.origin).toString();
};

export const openDocumentLinkDialog = (args: DocumentLinkDialogArgs) =>
  dialogCore.open<void>((close) => <DocumentLinkDialog args={args} close={close} />, panelDialogOptions);

function DocumentLinkDialog(props: { args: DocumentLinkDialogArgs; close: () => void }) {
  const locale = useLocale();
  const t = () => documentMessages.resolve([locale()]).t;
  const ttlOptions = () => [
    { value: "1d" as const, label: t().oneDay, description: t().shortHandoff },
    { value: "7d" as const, label: t().sevenDays, description: t().oneWeek },
    { value: "30d" as const, label: t().thirtyDays, description: t().default },
    { value: "90d" as const, label: t().ninetyDays, description: t().longRunning },
  ];
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
      if (!res.ok) throw new Error(await errorMessage(res, t().couldNotCreateDocumentLink));
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
    const option = ttlOptions()[index];
    if (!option) return;
    setExpiresIn(option.value);
    queueMicrotask(() => optionRefs[index]?.focus());
  };

  const onOptionKeyDown = (event: KeyboardEvent, index: number) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      selectOption((index + 1) % ttlOptions().length);
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      selectOption((index - 1 + ttlOptions().length) % ttlOptions().length);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      selectOption(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      selectOption(ttlOptions().length - 1);
    }
  };

  return (
    <PanelDialog>
      <PanelDialog.Header title={t().createLinkTitle} subtitle={props.args.document.filename} icon="ti ti-link" close={props.close} />
      <PanelDialog.Body>
        <Show
          when={createdUrl()}
          fallback={
            <section class="flex flex-col gap-3">
              <div>
                <p class="text-sm font-medium text-primary">{t().validity}</p>
                <div class="mt-2 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t().publicLinkValidity}>
                  <For each={ttlOptions()}>
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
                label={t().comment}
                description={t().commentDescription}
                value={comment}
                onValueChange={setComment}
                icon="ti ti-message"
                placeholder={t().commentPlaceholder}
              />
              <NoticeCard tone="info" title={t().anyoneCanDownload} detail={t().publicLinkScope} />
            </section>
          }
        >
          {(url) => (
            <section class="flex flex-col gap-3">
              <NoticeCard
                tone="success"
                title={copiedOnCreate() ? t().linkCreatedCopied : t().linkCreated}
                detail={copiedOnCreate() ? t().sharePdf : t().copyLinkGuidance}
              />
              <code class="block break-all rounded-[var(--ui-radius-control)] bg-[var(--ui-field)] p-2 font-mono text-xs text-secondary">
                {url()}
              </code>
              <div class="flex flex-wrap items-center gap-2">
                <CopyButton text={url()} label={t().copyLink} variant="secondary" size="sm" />
                <ButtonLink variant="secondary" size="sm" href={url()} target="_blank" rel="noreferrer">
                  <i class="ti ti-external-link" />
                  {t().openLink}
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
            {createdUrl() ? t().done : t().cancel}
          </Button>
          <Show when={!createdUrl()}>
            <Button variant="primary" size="sm" type="button" onClick={() => createMut.mutate(undefined)} disabled={createMut.loading()}>
              {createMut.loading() ? <i class="ti ti-loader-2 animate-spin" /> : <i class="ti ti-link-plus" />}
              {t().createLink}
            </Button>
          </Show>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}
