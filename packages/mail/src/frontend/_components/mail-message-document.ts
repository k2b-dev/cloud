const MIN_MESSAGE_BODY_HEIGHT = 32;
const MAX_INITIAL_MESSAGE_BODY_HEIGHT = 480;
const ESTIMATED_LINE_HEIGHT = 22;
const ESTIMATED_LINE_WIDTH = 88;

export const normalizeMessageBodyHeight = (value: number): number =>
  Number.isFinite(value) ? Math.max(Math.ceil(value), MIN_MESSAGE_BODY_HEIGHT) : MIN_MESSAGE_BODY_HEIGHT;

export const estimateInitialMessageBodyHeight = (plainText: string | null, html: string | null): number => {
  const source =
    plainText?.trim() ||
    html
      ?.replace(/<(br|hr)\b[^>]*>/giu, "\n")
      .replace(/<\/(address|article|blockquote|div|h[1-6]|li|p|pre|section|table|tr)>/giu, "\n")
      .replace(/<[^>]+>/gu, " ")
      .replace(/&nbsp;/giu, " ")
      .trim() ||
    "";
  if (!source) return MIN_MESSAGE_BODY_HEIGHT;

  const lineCount = source.split(/\r?\n/u).reduce((total, line) => {
    const length = line.trim().length;
    return total + Math.max(1, Math.ceil(length / ESTIMATED_LINE_WIDTH));
  }, 0);
  const mediaAllowance = html && /<(img|table)\b/iu.test(html) ? 96 : 0;
  return Math.min(
    Math.max(MIN_MESSAGE_BODY_HEIGHT, lineCount * ESTIMATED_LINE_HEIGHT + mediaAllowance + 2),
    MAX_INITIAL_MESSAGE_BODY_HEIGHT,
  );
};

const escapeHtmlAttribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const buildMessageDocument = (
  html: string,
  channel: string,
  linksDisabled = false,
  locale = "en",
  quotedTextLabel = "Show quoted text",
): string => {
  const channelLiteral = JSON.stringify(channel).replaceAll("<", "\\u003c");
  const quotedTextLabelLiteral = JSON.stringify(quotedTextLabel).replaceAll("<", "\\u003c");
  const linksDisabledLiteral = linksDisabled ? "true" : "false";
  const scriptNonce = channel.replace(/[^a-zA-Z0-9]/gu, "") || "mailbridge";
  return `<!doctype html>
<html lang="${escapeHtmlAttribute(locale)}">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; form-action 'none'; base-uri 'none'; object-src 'none'">
  <meta name="referrer" content="no-referrer">
  <style>
    :root { color-scheme: only light; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; color: #18181b; font: 14px/1.55 system-ui, sans-serif; overflow-wrap: anywhere; }
    body { padding: 1px; }
    img { max-width: 100%; height: auto; }
    table { max-width: 100%; border-collapse: collapse; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    a { color: #1677c8; }
    details.mail-quoted-history { margin-top: 12px; color: color-mix(in srgb, currentColor 65%, transparent); }
    details.mail-quoted-history > summary { cursor: pointer; user-select: none; font-size: 12px; font-weight: 600; }
    details.mail-quoted-history > blockquote,
    details.mail-quoted-history > div { margin: 8px 0 0; padding-left: 12px; border-left: 2px solid color-mix(in srgb, currentColor 25%, transparent); }
    #mail-message-root { display: flow-root; min-height: 0; }
  </style>
</head>
<body><div id="mail-message-root">${html}</div>
  <script nonce="${scriptNonce}">
    (() => {
      "use strict";
      const channel = ${channelLiteral};
      const linksDisabled = ${linksDisabledLiteral};
      const post = (type, value) => parent.postMessage({ source: "cloud-mail-message", channel, type, value }, "*");
      const quoteSelectors = 'blockquote[type="cite"], .gmail_quote, .yahoo_quoted';
      const candidates = [...document.querySelectorAll(quoteSelectors)].filter((node) => !node.parentElement?.closest("details.mail-quoted-history"));
      for (const node of candidates) {
        if (node.parentElement?.closest(quoteSelectors)) continue;
        const details = document.createElement("details");
        details.className = "mail-quoted-history";
        const summary = document.createElement("summary");
        summary.textContent = ${quotedTextLabelLiteral};
        node.replaceWith(details);
        details.append(summary, node);
      }
      for (const link of document.querySelectorAll("a[href]")) {
        if (linksDisabled) {
          link.removeAttribute("href");
          link.setAttribute("aria-disabled", "true");
          link.style.cursor = "not-allowed";
          continue;
        }
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      let selectionTimer = 0;
      document.addEventListener("selectionchange", () => {
        clearTimeout(selectionTimer);
        selectionTimer = setTimeout(() => post("selection", String(getSelection()?.toString() || "").trim().slice(0, 10000)), 25);
      });
      const root = document.getElementById("mail-message-root");
      const reportHeight = () => post("height", Math.ceil((root?.getBoundingClientRect().height || 0) + 2));
      addEventListener("message", (event) => {
        const data = event.data;
        if (
          event.source === parent &&
          data &&
          data.source === "cloud-mail-host" &&
          data.channel === channel &&
          data.type === "measure"
        ) reportHeight();
      });
      if (root) new ResizeObserver(reportHeight).observe(root);
      reportHeight();
    })();
  </script>
</body>
</html>`;
};
