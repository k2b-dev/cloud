import { importOnDemand } from "@k2b/cloud/browser/reload";
import type { CloudTheme } from "@k2b/cloud/shared";
import { mutation } from "@k2b/stdlib/solid";
import { toast, useLocale } from "@k2b/ui";
import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { apiClient } from "../../api/client";
import type { MessageRemoteContent, RemoteContentAllowRule, RemoteContentRule } from "../../service/remote-content";
import { readApiError } from "./api-response";
import MailRemoteImagesNotice, { type RemoteImagesNoticeKind } from "./MailRemoteImagesNotice";
import { buildMessageDocument, estimateInitialMessageBodyHeight, normalizeMessageBodyHeight } from "./mail-message-document";
import { mailMessageMessages } from "./mail-message-messages";
import {
  inlineBodyImages,
  type MessageBodyFormat,
  type MessageColors,
  markCidImageSources,
  normalizeContentId,
  plainTextClipboardHtml,
  referencedRemoteImageIds,
  splitPlainMessageSegments,
  splitPlainTextLinks,
} from "./mail-message-presentation";

const MAX_REMOTE_IMAGE_BYTES = 25 * 1024 * 1024;
const REMOTE_IMAGE_WORKERS = 2;
const REMOTE_IMAGE_REQUEST_GAP_MS = 350;

type FrameImage = { kind: "cid" | "remote"; id: string; image: Blob };

const sleep = (durationMs: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, durationMs));

// Rules the person removed on this page. A message snapshot can still list them until the server sends a new one, and a
// message body mounts again when its format changes. Removed rule ids never return, so one page-wide set keeps every
// open or remounted message from loading images through them. Only the browser writes it.
const [revokedRuleIds, setRevokedRuleIds] = createSignal<ReadonlySet<string>>(new Set());

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
  theme: CloudTheme | null;
  colors: MessageColors;
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
  const [loadedRemoteIds, setLoadedRemoteIds] = createSignal<ReadonlySet<string>>(new Set());
  const [remoteLoading, setRemoteLoading] = createSignal(false);
  // Whether the running load is one the person asked for; a rule's automatic load shows no progress row.
  const [remoteLoadAsked, setRemoteLoadAsked] = createSignal(false);
  // How the last load ended: some images failed, or the message reached the safe size limit.
  const [remoteOutcome, setRemoteOutcome] = createSignal<"none" | "failed" | "limited">("none");
  const [remoteAnnouncement, setRemoteAnnouncement] = createSignal("");
  // Rules saved from this message, until the next message snapshot from the server lists other rules.
  const [addedRules, setAddedRules] = createSignal<RemoteContentAllowRule[]>([]);
  let frame: HTMLIFrameElement | undefined;
  let remoteController: AbortController | null = null;
  let remoteLoadedBytes = 0;
  let disposed = false;
  // Loaded images and opened quotes stay here so a reloaded frame document gets
  // them back. The frame reloads whenever the reader moves this message in the
  // DOM or a new security verdict changes the document.
  const frameImages: FrameImage[] = [];
  const openQuotes = new Set<number>();
  // Split only when the text itself changes: a refreshed message snapshot with
  // the same body must keep its segments, and with them any opened quote.
  const plainText = createMemo(() => props.plainText ?? "");
  const plainSegments = createMemo(() => splitPlainMessageSegments(plainText()));
  const remoteImageIds = createMemo(() => {
    if (props.format !== "html" || props.linksDisabled) return [];
    const stored = new Set(props.remoteContent.imageIds.map((id) => id.toLowerCase()));
    return referencedRemoteImageIds(props.html ?? "").filter((id) => stored.has(id));
  });
  const remoteImagesRemaining = createMemo(() => remoteImageIds().filter((id) => !loadedRemoteIds().has(id)).length);
  // A live snapshot updates the rule list in place, so compare its contents, not its identity.
  createEffect(
    on(
      () => props.remoteContent.allowRules.map((rule) => rule.id).join(" "),
      () => setAddedRules([]),
      { defer: true },
    ),
  );
  const allowRules = createMemo(() => {
    const revoked = revokedRuleIds();
    const rules = new Map<string, RemoteContentAllowRule>();
    for (const rule of [...props.remoteContent.allowRules, ...addedRules()]) if (!revoked.has(rule.id)) rules.set(rule.id, rule);
    return [...rules.values()];
  });
  const noticeKind = createMemo((): RemoteImagesNoticeKind | null => {
    if (remoteImageIds().length === 0) return null;
    if (remoteLoading() && remoteLoadAsked()) return "loading";
    const outcome = remoteOutcome();
    if (!remoteLoading() && outcome !== "none") return outcome;
    if (allowRules().length > 0) return "always";
    if (remoteLoading()) return "loading";
    return remoteImagesRemaining() === 0 ? "once" : "blocked";
  });
  // The frame document never depends on loaded images: replacing srcdoc
  // reloads the whole message. Images reach the running frame as messages.
  const appearanceMode = () => (props.colors === "original" ? "light" : (props.theme ?? "auto"));
  const documentSource = createMemo(() => {
    const localized = localization();
    return buildMessageDocument(
      markCidImageSources(props.format === "html" ? (props.html ?? "") : ""),
      channel,
      props.linksDisabled,
      localized.locale,
      { show: localized.t.showQuotedText, hide: localized.t.hideQuotedText },
      untrack(appearanceMode),
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

  // Plain text keeps its line breaks in <pre>, and a copied <pre> reaches editors as a code block. A copy that
  // touches the message puts its text on the clipboard as plain text and as simple paragraphs instead. Within the
  // message, the text comes from the shown segments, without the quote toggle's labels.
  const segmentText = (range: Range, body: HTMLElement): string =>
    [...body.querySelectorAll("pre")]
      .filter((segment) => range.intersectsNode(segment) && !segment.closest("details:not([open])"))
      .map((segment) => {
        const part = document.createRange();
        part.selectNodeContents(segment);
        if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) part.setStart(range.startContainer, range.startOffset);
        if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset);
        return part.toString();
      })
      .join("\n");
  const copyPlainText = (event: ClipboardEvent) => {
    const selection = window.getSelection();
    const body = plainBody;
    if (event.defaultPrevented || !event.clipboardData || !selection || selection.isCollapsed || !body?.isConnected) return;
    const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
    if (!ranges.some((range) => range.intersectsNode(body))) return;
    const text = ranges.every((range) => body.contains(range.commonAncestorContainer))
      ? ranges.map((range) => segmentText(range, body)).join("\n")
      : selection.toString();
    event.clipboardData.setData("text/plain", text);
    event.clipboardData.setData("text/html", plainTextClipboardHtml(text));
    event.preventDefault();
  };

  const sendFrameImages = (images: FrameImage[]) => {
    if (images.length === 0) return;
    frame?.contentWindow?.postMessage({ source: "cloud-mail-host", channel, type: "images", value: images }, "*");
  };

  const showFrameImage = (image: FrameImage) => {
    frameImages.push(image);
    sendFrameImages([image]);
  };

  const loadRemoteImages = async (asked: boolean) => {
    if (remoteLoading() || remoteImagesRemaining() === 0) return;
    remoteController?.abort();
    const controller = new AbortController();
    remoteController = controller;
    // One change, so a retry goes straight from failed to loading and the row keeps the focus.
    batch(() => {
      setRemoteLoadAsked(asked);
      setRemoteOutcome("none");
      setRemoteLoading(true);
      if (asked) setRemoteAnnouncement(messages().imagesLoading);
    });
    const pending = remoteImageIds().filter((id) => !loadedRemoteIds().has(id));
    let budgetExhausted = false;
    let cursor = 0;
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
          showFrameImage({ kind: "remote", id: imageId, image: blob });
          setLoadedRemoteIds((current) => new Set(current).add(imageId));
        } catch (error) {
          if (!disposed && !controller.signal.aborted) {
            console.warn("Could not load remote email image", error);
          }
        } finally {
          if (!disposed && !controller.signal.aborted) await sleep(REMOTE_IMAGE_REQUEST_GAP_MS);
        }
      }
    };
    let settledOutcome: "none" | "failed" | "limited" | null = null;
    try {
      await Promise.all(Array.from({ length: Math.min(REMOTE_IMAGE_WORKERS, pending.length) }, worker));
      // The outcome stays in the row above the message, with a retry where one can help.
      settledOutcome = budgetExhausted ? "limited" : remoteImagesRemaining() > 0 ? "failed" : "none";
    } finally {
      if (remoteController === controller) remoteController = null;
      if (!disposed && !controller.signal.aborted) {
        const outcome = settledOutcome ?? "failed";
        batch(() => {
          setRemoteOutcome(outcome);
          setRemoteLoading(false);
          if (outcome === "limited") setRemoteAnnouncement(`${messages().imagesLimited}. ${messages().imagesLimitedReason}`);
          else if (outcome === "none" && asked) setRemoteAnnouncement(messages().imagesLoaded);
        });
      }
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
    onSuccess: (rule) => {
      setAddedRules((current) => [
        ...current.filter((known) => known.id !== rule.id),
        { id: rule.id, scope: rule.scope, value: rule.value },
      ]);
      if (remoteImagesRemaining() > 0) void loadRemoteImages(true);
      else setRemoteAnnouncement(messages().imagesNowAlways);
    },
    onError: (error) => toast.error(error.message),
  });

  // Removes every rule that loads these images, so they stop loading automatically; the shown images stay.
  const revokeRemoteContent = mutation.create<string[], readonly RemoteContentAllowRule[]>({
    mutation: async (rules, { abortSignal }) => {
      const removed: string[] = [];
      for (const rule of rules) {
        const response = await apiClient.mailboxes[":mailboxId"]["remote-content-rules"][":ruleId"].$delete(
          { param: { mailboxId: props.mailboxId, ruleId: rule.id } },
          { init: { signal: abortSignal } },
        );
        // A rule that is already gone no longer loads anything.
        if (!response.ok && response.status !== 404) {
          if (removed.length > 0) setRevokedRuleIds((current) => new Set([...current, ...removed]));
          throw new Error(await readApiError(response, messages().remoteRuleRemoveFailed));
        }
        removed.push(rule.id);
      }
      return removed;
    },
    onSuccess: (removed) => {
      setRevokedRuleIds((current) => new Set([...current, ...removed]));
      setRemoteAnnouncement(messages().imagesNoLongerAutomatic);
    },
    onError: (error) => toast.error(error.message),
  });

  const openRemoteContentRules = async () => {
    const rules = await importOnDemand(() => import("./MailRemoteContentRulesDialog"));
    if (rules && !disposed) await rules.openMailRemoteContentRulesDialog(props.mailboxId);
  };

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
    if (data.type === "quote" && data.value && typeof data.value === "object") {
      const quote = data.value as { index?: unknown; open?: unknown };
      if (typeof quote.index !== "number" || !Number.isSafeInteger(quote.index) || quote.index < 0) return;
      if (quote.open === true) openQuotes.add(quote.index);
      if (quote.open === false) openQuotes.delete(quote.index);
    }
  };

  const requestFrameMeasurement = () => {
    frame?.contentWindow?.postMessage({ source: "cloud-mail-host", channel, type: "measure" }, "*");
  };

  const sendFrameAppearance = () => {
    const mode = appearanceMode();
    if (mode === "auto" || !frame?.parentElement) return;
    const text = getComputedStyle(frame.parentElement).color;
    let background: string | null = null;
    for (let ancestor: HTMLElement | null = frame.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const color = getComputedStyle(ancestor).backgroundColor;
      if (color !== "transparent" && !color.startsWith("rgba(") && !color.includes("/")) {
        background = color;
        break;
      }
    }
    frame.contentWindow?.postMessage({ source: "cloud-mail-host", channel, type: "appearance", value: { mode, text, background } }, "*");
  };
  createEffect(sendFrameAppearance);

  // The sandboxed document cannot inherit the person's motion choice from the host.
  const sendFrameMotion = () => {
    frame?.contentWindow?.postMessage(
      {
        source: "cloud-mail-host",
        channel,
        type: "motion",
        value: { reduced: document.documentElement.getAttribute("data-k2b-motion") === "reduced" },
      },
      "*",
    );
  };

  const handleFrameLoad = () => {
    sendFrameAppearance();
    if (openQuotes.size > 0) {
      frame?.contentWindow?.postMessage({ source: "cloud-mail-host", channel, type: "quotes", value: [...openQuotes] }, "*");
    }
    sendFrameImages(frameImages);
    sendFrameMotion();
    requestFrameMeasurement();
  };

  const loadCidImages = async (signal: AbortSignal) => {
    const selected = inlineBodyImages(props.html ?? "", props.attachments);
    for (const attachment of selected) {
      const response = await fetch(
        `/api/mail/mailboxes/${props.mailboxId}/messages/${props.messageId}/attachments/${attachment.id}?inline=true`,
        { credentials: "same-origin", signal },
      );
      if (!response.ok) continue;
      const blob = await response.blob();
      if (disposed || signal.aborted) return;
      showFrameImage({ kind: "cid", id: normalizeContentId(attachment.contentId!), image: blob });
    }
  };

  // The message stays mounted across live updates, so images follow the
  // current security verdict: a quarantined body drops loaded images and stops
  // pending requests, and a cleared one loads its inline images again.
  const imagesAllowed = () => props.format === "html" && !props.linksDisabled;
  createEffect(
    on(imagesAllowed, (allowed) => {
      if (!allowed) {
        remoteController?.abort();
        remoteController = null;
        remoteLoadedBytes = 0;
        frameImages.length = 0;
        setLoadedRemoteIds(new Set<string>());
        setRemoteLoading(false);
        setRemoteOutcome("none");
        return;
      }
      const controller = new AbortController();
      onCleanup(() => controller.abort());
      void loadCidImages(controller.signal).catch((error) => {
        if (!controller.signal.aborted) console.warn("Could not load inline email image", error);
      });
    }),
  );
  // A sender or domain rule saved elsewhere reaches this message as a live update. A rule removed on this page no longer
  // loads anything, even while the snapshot still lists it. The memo loads only when the answer turns true, not each time
  // another message's rule is removed.
  const autoLoadAllowed = createMemo(
    () =>
      imagesAllowed() &&
      props.remoteContent.allowedByRule &&
      props.remoteContent.allowRules.every((rule) => !revokedRuleIds().has(rule.id)),
  );
  createEffect(
    on(autoLoadAllowed, (autoLoad) => {
      if (autoLoad) void loadRemoteImages(false);
    }),
  );

  onMount(() => {
    window.addEventListener("message", receiveMessage);
    // A selection that starts in the message header never sends its copy event through the body.
    document.addEventListener("copy", copyPlainText);
    sendFrameMotion();
    const motionObserver = new MutationObserver(sendFrameMotion);
    motionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-k2b-motion"] });
    requestAnimationFrame(requestFrameMeasurement);
    if (props.format === "plain" && props.plainText?.trim()) document.addEventListener("selectionchange", reportPlainSelection);
    onCleanup(() => {
      disposed = true;
      allowRemoteContent.abort();
      revokeRemoteContent.abort();
      remoteController?.abort();
      frameImages.length = 0;
      motionObserver.disconnect();
      window.removeEventListener("message", receiveMessage);
      document.removeEventListener("copy", copyPlainText);
      document.removeEventListener("selectionchange", reportPlainSelection);
      props.onSelectionChange("");
    });
  });

  return (
    <Show
      when={props.format === "html" ? props.html : null}
      fallback={
        <Show when={props.plainText?.trim()}>
          <div ref={plainBody} class="flex max-w-[72ch] flex-col gap-2">
            <For each={plainSegments()}>
              {(segment) =>
                segment.kind === "quote" ? (
                  <details class="group/quote text-secondary">
                    <summary class="focus-ui inline-flex w-fit cursor-pointer select-none list-none items-center gap-1.5 rounded-[var(--ui-radius-control)] py-1 pl-1.5 pr-2 text-xs font-medium transition-colors hover:bg-[var(--ui-hover)] hover:text-primary [&::-webkit-details-marker]:hidden">
                      <i
                        class="ti ti-chevron-right text-sm transition-transform group-open/quote:rotate-90 motion-reduce:transition-none"
                        aria-hidden="true"
                      />
                      {/* Both labels share one grid cell, so switching them never resizes the toggle. */}
                      <span class="inline-grid">
                        <span class="[grid-area:1/1] group-open/quote:invisible">{messages().showQuotedText}</span>
                        <span class="invisible [grid-area:1/1] group-open/quote:visible">{messages().hideQuotedText}</span>
                      </span>
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
        <Show when={noticeKind()}>
          {(kind) => (
            <MailRemoteImagesNotice
              kind={kind()}
              messages={messages()}
              locale={localization().locale}
              loaded={loadedRemoteIds().size}
              total={remoteImageIds().length}
              sender={props.remoteContent.sender}
              domain={props.remoteContent.domain}
              rules={allowRules()}
              busy={allowRemoteContent.loading() || revokeRemoteContent.loading()}
              announcement={remoteAnnouncement()}
              onLoad={() => void loadRemoteImages(true)}
              onAllow={(rule) => void allowRemoteContent.mutate(rule)}
              onRevoke={() => void revokeRemoteContent.mutate(allowRules())}
              onOpenRules={() => void openRemoteContentRules()}
            />
          )}
        </Show>
        <iframe
          ref={frame}
          title={messages().messageContent}
          class={`block w-full overflow-hidden rounded-[var(--ui-radius-surface)] border-0 ${appearanceMode() === "auto" ? "bg-white dark:bg-transparent" : appearanceMode() === "dark" ? "bg-transparent" : "bg-white"}`}
          style={{ height: `${height()}px` }}
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          referrerpolicy="no-referrer"
          srcdoc={documentSource()}
          onLoad={handleFrameLoad}
        />
      </div>
    </Show>
  );
}
