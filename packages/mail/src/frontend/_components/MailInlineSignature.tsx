import { useLocale } from "@k2b/ui";
import {
  type Accessor,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { apiClient } from "../../api/client";
import { readApiError } from "./api-response";
import { mailComposerMessages } from "./mail-composer-messages";
import { buildMessageDocument, type MessageAppearanceMode, normalizeMessageBodyHeight } from "./mail-message-document";
import { mailMessageMessages } from "./mail-message-messages";

/** Cloud writes the person's theme as a class on the root element; the frame follows it like the reader does. */
const hostAppearance = (): MessageAppearanceMode => {
  const root = document.documentElement.classList;
  return root.contains("dark") ? "dark" : root.contains("light") ? "light" : "auto";
};

/**
 * In the sent message, the signature's outer margins set it apart from the text above it; here the block after the
 * text does that, as for a plain signature. Only these outer margins go; markup, design, and inner spacing stay as sent.
 */
const SIGNATURE_EDGES =
  ".mail-signature, .mail-signature > :first-child { margin-block-start: 0 !important; } .mail-signature, .mail-signature > :last-child { margin-block-end: 0 !important; }";

/**
 * The signature exactly as the sent HTML message shows it, in the reader's sandboxed message document: no script of
 * the message runs and nothing loads from the network. The frame keeps its last height until the new document reports
 * its own, so switching the signature never moves the text around it.
 */
const SentSignatureFrame = (props: { html: string; title: string }) => {
  const locale = useLocale();
  const localization = createMemo(() => mailMessageMessages.resolve([locale()]));
  const channel = `mail-signature-${createUniqueId()}`;
  const [height, setHeight] = createSignal<number | null>(null);
  const [appearance, setAppearance] = createSignal<MessageAppearanceMode>(hostAppearance());
  let frame: HTMLIFrameElement | undefined;
  const documentSource = createMemo(() => {
    const localized = localization();
    return buildMessageDocument(
      props.html,
      channel,
      false,
      localized.locale,
      { show: localized.t.showQuotedText, hide: localized.t.hideQuotedText },
      untrack(appearance),
      SIGNATURE_EDGES,
    );
  });
  // The same colors the reader hands its message frame: the text color here and the first solid background behind it.
  const sendAppearance = () => {
    const mode = appearance();
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
  createEffect(sendAppearance);
  const receive = (event: MessageEvent) => {
    if (!frame || event.source !== frame.contentWindow || !event.data || typeof event.data !== "object") return;
    const data = event.data as { source?: unknown; channel?: unknown; type?: unknown; value?: unknown };
    if (data.source !== "cloud-mail-message" || data.channel !== channel) return;
    if (data.type === "height" && typeof data.value === "number" && Number.isFinite(data.value)) {
      setHeight(normalizeMessageBodyHeight(data.value));
    }
  };
  onMount(() => {
    window.addEventListener("message", receive);
    const themeObserver = new MutationObserver(() => setAppearance(hostAppearance()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    onCleanup(() => {
      window.removeEventListener("message", receive);
      themeObserver.disconnect();
    });
  });
  return (
    <iframe
      ref={frame}
      class="mail-inline-draft-signature-frame"
      data-mail-signature-frame
      title={props.title}
      // Until the first document reports its height, the frame takes no room, like an empty signature line.
      style={{ height: `${height() ?? 0}px` }}
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      referrerpolicy="no-referrer"
      srcdoc={documentSource()}
      onLoad={() => {
        sendAppearance();
        frame?.contentWindow?.postMessage({ source: "cloud-mail-host", channel, type: "measure" }, "*");
      }}
    />
  );
};

/**
 * The chosen signature as a fixed block after the text (F3): exactly what Mail inserts at send, not editable here. An
 * HTML draft shows the sent signature with the mailbox design and logo; a plain draft shows the text that is sent. The
 * signature menu in the draft's tools switches it. While a new choice loads, the last one stays, so the block does not
 * jump; if it cannot load, a quiet line says Mail still adds it when sending.
 */
export default function MailInlineSignature(props: {
  mailboxId: string;
  senderIdentityId: Accessor<string>;
  signatureTemplateId: Accessor<string | null>;
  format: Accessor<"plain" | "markdown">;
}) {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  const source = () => {
    const signatureTemplateId = props.signatureTemplateId();
    if (typeof window === "undefined" || !signatureTemplateId || !props.senderIdentityId()) return false;
    return JSON.stringify({ senderIdentityId: props.senderIdentityId(), signatureTemplateId, format: props.format() });
  };
  const [signature] = createResource(source, async (key) => {
    const response = await apiClient.mailboxes[":mailboxId"]["compose-signature"].$post({
      param: { mailboxId: props.mailboxId },
      json: JSON.parse(key),
    });
    if (!response.ok) throw new Error(await readApiError(response, t().signatureUnavailable));
    const { text, mailHtml } = await response.json();
    return { text, mailHtml };
  });
  return (
    <Show when={props.signatureTemplateId()}>
      <div
        class="mail-inline-draft-signature"
        data-mail-draft-signature
        // A failed load holds its error in `latest`, so the error is checked before the value is read.
        data-signature-sent-html={!signature.error && signature.latest?.mailHtml ? "" : undefined}
        role="group"
        aria-label={t().signatureBlock}
      >
        <Show when={!signature.error} fallback={<span class="mail-inline-draft-signature-note">{t().signatureAtSend}</span>}>
          <Show when={signature.latest?.mailHtml} fallback={signature.latest?.text ?? ""}>
            {(html) => <SentSignatureFrame html={html()} title={t().signatureBlock} />}
          </Show>
        </Show>
      </div>
    </Show>
  );
}
