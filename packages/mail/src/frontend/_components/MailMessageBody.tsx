import { mutation } from "@k2b/stdlib/solid";
import { Button, NoticeCard, prompts, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { MessageRemoteContent, RemoteContentRule } from "../../service/remote-content";
import { readApiError } from "./api-response";
import { buildMessageDocument, estimateInitialMessageBodyHeight, normalizeMessageBodyHeight } from "./mail-message-document";
import { mailMessageMessages } from "./mail-message-messages";
import {
  type MessageBodyFormat,
  normalizeContentId,
  referencedContentIds,
  referencedRemoteImageIds,
  rewriteCidSources,
  rewriteRemoteImageSources,
  splitPlainMessageSegments,
  splitPlainTextLinks,
} from "./mail-message-presentation";

const MAX_INLINE_IMAGE_COUNT = 32;
const MAX_INLINE_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_REMOTE_IMAGE_BYTES = 25 * 1024 * 1024;
const REMOTE_IMAGE_WORKERS = 2;
const REMOTE_IMAGE_REQUEST_GAP_MS = 350;

const sleep = (durationMs: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, durationMs));

const PlainText = (props: { value: string; linksDisabled?: boolean }) => (
  <For each={splitPlainTextLinks(props.value)}>
    {(segment) => (
      <Show when={segment.kind === "link" && !props.linksDisabled} fallback={segment.text}>
        <a
          href={segment.kind === "link" ? segment.href : undefined}
          target="_blank"
          rel="noopener noreferrer nofollow"
          class="text-current no-underline hover:underline focus-visible:underline"
        >
          {segment.text}
        </a>
      </Show>
    )}
  </For>
);

export default function MailMessageBody(props: {
  mailboxId: string;
  messageId: string;
  format: MessageBodyFormat;
  html: string | null;
  plainText: string | null;
  attachments: Array<{ id: string; contentId: string | null; contentType: string; sizeBytes: number }>;
  remoteContent: MessageRemoteContent;
  linksDisabled?: boolean;
  onSelectionChange: (value: string) => void;
}) {
  const locale = useLocale();
  const localization = createMemo(() => mailMessageMessages.resolve([locale()]));
  const messages = createMemo(() => localization().t);
  // These values are serialized into the SSR markup. Keep them deterministic
  // so hydration preserves the already-rendered message frame.
  const channel = `mail-message-${props.messageId}`;
  const [height, setHeight] = createSignal(estimateInitialMessageBodyHeight(props.plainText, props.html));
  const [cidUrls, setCidUrls] = createSignal(new Map<string, string>());
  const [remoteUrls, setRemoteUrls] = createSignal(new Map<string, string>());
  const [remoteLoading, setRemoteLoading] = createSignal(false);
  let frame: HTMLIFrameElement | undefined;
  let remoteController: AbortController | null = null;
  let remoteFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let remoteLoadedBytes = 0;
  let disposed = false;
  const remoteObjectUrls = new Set<string>();
  const plainSegments = createMemo(() => splitPlainMessageSegments(props.plainText ?? ""));
  const remoteImageIds = createMemo(() => {
    if (props.format !== "html" || props.linksDisabled) return [];
    const stored = new Set(props.remoteContent.imageIds.map((id) => id.toLowerCase()));
    return referencedRemoteImageIds(props.html ?? "").filter((id) => stored.has(id));
  });
  const remoteImagesRemaining = createMemo(() => remoteImageIds().filter((id) => !remoteUrls().has(id)).length);
  const documentSource = createMemo(() => {
    const withCidImages = rewriteCidSources(props.format === "html" ? (props.html ?? "") : "", cidUrls());
    const localized = localization();
    return buildMessageDocument(
      rewriteRemoteImageSources(withCidImages, remoteUrls()),
      channel,
      props.linksDisabled,
      localized.locale,
      localized.t.showQuotedText,
    );
  });
  let plainBody: HTMLDivElement | undefined;

  const reportPlainSelection = () => {
    const selection = window.getSelection();
    const value =
      selection?.anchorNode && selection.focusNode && plainBody?.contains(selection.anchorNode) && plainBody.contains(selection.focusNode)
        ? selection.toString().trim().slice(0, 10_000)
        : "";
    props.onSelectionChange(value);
  };

  const loadRemoteImages = async () => {
    if (remoteLoading() || remoteImagesRemaining() === 0) return;
    remoteController?.abort();
    const controller = new AbortController();
    remoteController = controller;
    setRemoteLoading(true);
    const pending = remoteImageIds().filter((id) => !remoteUrls().has(id));
    const loaded: Array<[string, string]> = [];
    let loadedCount = 0;
    let budgetExhausted = false;
    let cursor = 0;
    const flushLoaded = () => {
      if (remoteFlushTimer) clearTimeout(remoteFlushTimer);
      remoteFlushTimer = null;
      if (loaded.length === 0 || disposed || controller.signal.aborted) return;
      const batch = loaded.splice(0);
      setRemoteUrls((current) => new Map([...current, ...batch]));
    };
    const scheduleFlush = () => {
      if (remoteFlushTimer) return;
      remoteFlushTimer = setTimeout(flushLoaded, 150);
    };
    const worker = async () => {
      while (!controller.signal.aborted && !budgetExhausted) {
        const index = cursor;
        cursor += 1;
        const imageId = pending[index];
        if (!imageId) return;
        try {
          const response = await fetch(`/api/mail/mailboxes/${props.mailboxId}/messages/${props.messageId}/remote-images/${imageId}`, {
            credentials: "same-origin",
            signal: controller.signal,
          });
          if (!response.ok) continue;
          const blob = await response.blob();
          if (disposed || controller.signal.aborted) return;
          if (budgetExhausted || remoteLoadedBytes + blob.size > MAX_REMOTE_IMAGE_BYTES) {
            budgetExhausted = true;
            return;
          }
          remoteLoadedBytes += blob.size;
          const objectUrl = URL.createObjectURL(blob);
          remoteObjectUrls.add(objectUrl);
          loaded.push([imageId, objectUrl]);
          loadedCount += 1;
          scheduleFlush();
        } catch (error) {
          if (!disposed && !controller.signal.aborted) {
            console.warn("Could not load remote email image", error);
          }
        } finally {
          if (!disposed && !controller.signal.aborted) await sleep(REMOTE_IMAGE_REQUEST_GAP_MS);
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(REMOTE_IMAGE_WORKERS, pending.length) }, worker));
      flushLoaded();
      if (loadedCount === 0 && !disposed && !controller.signal.aborted) {
        void prompts.error(messages().remoteImagesFailed);
      } else if (budgetExhausted && !disposed && !controller.signal.aborted) {
        void prompts.error(messages().remoteImagesLimited);
      }
    } finally {
      if (remoteController === controller) remoteController = null;
      if (!disposed && !controller.signal.aborted) setRemoteLoading(false);
    }
  };

  const allowRemoteContent = mutation.create<RemoteContentRule, { scope: "sender" | "domain"; value: string }>({
    mutation: async (input, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["remote-content-rules"].$post(
        {
          param: { mailboxId: props.mailboxId },
          json: input,
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().remotePreferenceFailed));
      return response.json();
    },
    onSuccess: () => void loadRemoteImages(),
    onError: (error) => prompts.error(error.message),
  });

  const receiveMessage = (event: MessageEvent) => {
    if (!frame || event.source !== frame.contentWindow || !event.data || typeof event.data !== "object") return;
    const data = event.data as { source?: unknown; channel?: unknown; type?: unknown; value?: unknown };
    if (data.source !== "cloud-mail-message" || data.channel !== channel) return;
    if (data.type === "height" && typeof data.value === "number" && Number.isFinite(data.value)) {
      setHeight(normalizeMessageBodyHeight(data.value));
    }
    if (data.type === "selection" && typeof data.value === "string") {
      props.onSelectionChange(data.value.slice(0, 10_000));
    }
  };

  const requestFrameMeasurement = () => {
    frame?.contentWindow?.postMessage({ source: "cloud-mail-host", channel, type: "measure" }, "*");
  };

  onMount(() => {
    window.addEventListener("message", receiveMessage);
    requestAnimationFrame(requestFrameMeasurement);
    if (props.format === "plain" && props.plainText) document.addEventListener("selectionchange", reportPlainSelection);
    const controller = new AbortController();
    const objectUrls = new Set<string>();
    const loadCidImages = async () => {
      const referenced = new Set(referencedContentIds(props.html ?? ""));
      let selectedBytes = 0;
      const selected = props.attachments
        .filter((attachment) => {
          if (!attachment.contentId || !attachment.contentType.toLowerCase().startsWith("image/")) return false;
          if (!referenced.has(normalizeContentId(attachment.contentId))) return false;
          if (!Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes < 0) return false;
          if (selectedBytes + attachment.sizeBytes > MAX_INLINE_IMAGE_BYTES) return false;
          selectedBytes += attachment.sizeBytes;
          return true;
        })
        .slice(0, MAX_INLINE_IMAGE_COUNT);
      const entries: Array<[string, string]> = [];
      for (const attachment of selected) {
        const response = await fetch(
          `/api/mail/mailboxes/${props.mailboxId}/messages/${props.messageId}/attachments/${attachment.id}?inline=true`,
          { credentials: "same-origin", signal: controller.signal },
        );
        if (!response.ok) continue;
        const blob = await response.blob();
        if (disposed || controller.signal.aborted) return;
        const objectUrl = URL.createObjectURL(blob);
        objectUrls.add(objectUrl);
        entries.push([normalizeContentId(attachment.contentId!), objectUrl]);
      }
      if (!disposed) setCidUrls(new Map(entries));
    };
    if (props.format === "html" && !props.linksDisabled) {
      void loadCidImages().catch((error) => {
        if (!controller.signal.aborted) console.warn("Could not load inline email image", error);
      });
      if (props.remoteContent.allowedByRule) void loadRemoteImages();
    }
    onCleanup(() => {
      disposed = true;
      controller.abort();
      allowRemoteContent.abort();
      remoteController?.abort();
      if (remoteFlushTimer) clearTimeout(remoteFlushTimer);
      remoteFlushTimer = null;
      for (const url of objectUrls) URL.revokeObjectURL(url);
      for (const url of remoteObjectUrls) URL.revokeObjectURL(url);
      objectUrls.clear();
      remoteObjectUrls.clear();
      window.removeEventListener("message", receiveMessage);
      document.removeEventListener("selectionchange", reportPlainSelection);
      props.onSelectionChange("");
    });
  });

  return (
    <Show
      when={props.format === "html" ? props.html : null}
      fallback={
        <Show when={props.plainText}>
          <div ref={plainBody} class="flex max-w-[72ch] flex-col gap-2">
            <For each={plainSegments()}>
              {(segment) =>
                segment.kind === "quote" ? (
                  <details class="text-secondary">
                    <summary class="w-fit cursor-pointer select-none rounded-[var(--ui-radius-control)] px-2 py-1 text-xs font-medium hover:bg-[var(--ui-hover)]">
                      {messages().showQuotedText}
                    </summary>
                    <pre class="mt-2 whitespace-pre-wrap break-words border-l-2 border-default pl-3 font-sans text-sm">
                      <PlainText value={segment.text} linksDisabled={props.linksDisabled} />
                    </pre>
                  </details>
                ) : (
                  <pre class="whitespace-pre-wrap break-words font-sans text-sm">
                    <PlainText value={segment.text} linksDisabled={props.linksDisabled} />
                  </pre>
                )
              }
            </For>
          </div>
        </Show>
      }
    >
      <div class="flex min-w-0 flex-col gap-2">
        <Show when={remoteImagesRemaining() > 0}>
          <NoticeCard tone="neutral" icon={false} bodyClass="flex flex-wrap items-center gap-2">
            <i class="ti ti-photo-shield shrink-0" aria-hidden="true" />
            <span class="min-w-48 flex-1">{messages().remoteImagesBlocked}</span>
            <Button variant="secondary" size="xs" type="button" disabled={remoteLoading()} onClick={() => void loadRemoteImages()}>
              <i class={`ti ${remoteLoading() ? "ti-loader-2 animate-spin" : "ti-photo"}`} aria-hidden="true" />
              {messages().loadImages}
            </Button>
            <Show when={props.remoteContent.sender}>
              {(sender) => (
                <Button
                  variant="ghost"
                  size="xs"
                  type="button"
                  disabled={remoteLoading() || allowRemoteContent.loading()}
                  onClick={() => void allowRemoteContent.mutate({ scope: "sender", value: sender() })}
                >
                  {messages().alwaysForSender}
                </Button>
              )}
            </Show>
            <Show when={props.remoteContent.domain}>
              {(domain) => (
                <Button
                  variant="ghost"
                  size="xs"
                  type="button"
                  disabled={remoteLoading() || allowRemoteContent.loading()}
                  onClick={() => void allowRemoteContent.mutate({ scope: "domain", value: domain() })}
                >
                  {messages().alwaysForDomain}
                </Button>
              )}
            </Show>
          </NoticeCard>
        </Show>
        <iframe
          ref={frame}
          title={messages().messageContent}
          class="block w-full overflow-hidden rounded-[var(--ui-radius-surface)] border-0 bg-white"
          style={{ height: `${height()}px` }}
          sandbox="allow-scripts allow-popups"
          referrerpolicy="no-referrer"
          srcdoc={documentSource()}
          onLoad={requestFrameMeasurement}
        />
      </div>
    </Show>
  );
}
