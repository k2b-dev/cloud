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

export type QuotedTextLabels = { show: string; hide: string };

export const buildMessageDocument = (
  html: string,
  channel: string,
  linksDisabled = false,
  locale = "en",
  quotedTextLabels: QuotedTextLabels = { show: "Show quoted text", hide: "Hide quoted text" },
): string => {
  const channelLiteral = JSON.stringify(channel).replaceAll("<", "\\u003c");
  const quotedTextLabelsLiteral = JSON.stringify(quotedTextLabels).replaceAll("<", "\\u003c");
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
    details.mail-quoted-history { margin-top: 12px; }
    details.mail-quoted-history > :not(summary),
    details.mail-quoted-history > summary { color: color-mix(in srgb, currentColor 65%, transparent); }
    details.mail-quoted-history > summary { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px 4px 6px; border-radius: 6px; font-size: 12px; font-weight: 500; line-height: 16px; list-style: none; cursor: pointer; user-select: none; transition: background-color 120ms ease, color 120ms ease; }
    details.mail-quoted-history > summary::-webkit-details-marker { display: none; }
    details.mail-quoted-history > summary:hover { background: color-mix(in srgb, currentColor 6%, transparent); color: inherit; }
    details.mail-quoted-history > summary:focus-visible { outline: 2px solid #1677c8; outline-offset: 1px; }
    details.mail-quoted-history > summary > svg { flex: none; width: 14px; height: 14px; transition: transform 160ms ease; }
    details.mail-quoted-history[open] > summary > svg { transform: rotate(90deg); }
    .mail-quoted-labels { display: inline-grid; }
    .mail-quoted-labels > span { grid-area: 1 / 1; }
    details.mail-quoted-history:not([open]) > summary .mail-quoted-hide,
    details.mail-quoted-history[open] > summary .mail-quoted-show { visibility: hidden; }
    @media (prefers-reduced-motion: reduce) { details.mail-quoted-history > summary, details.mail-quoted-history > summary > svg { transition: none; } }
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
      const quotedTextLabels = ${quotedTextLabelsLiteral};
      const svgNamespace = "http://www.w3.org/2000/svg";
      const quoteChevron = () => {
        const icon = document.createElementNS(svgNamespace, "svg");
        icon.setAttribute("viewBox", "0 0 24 24");
        icon.setAttribute("fill", "none");
        icon.setAttribute("stroke", "currentColor");
        icon.setAttribute("stroke-width", "2");
        icon.setAttribute("stroke-linecap", "round");
        icon.setAttribute("stroke-linejoin", "round");
        icon.setAttribute("aria-hidden", "true");
        const path = document.createElementNS(svgNamespace, "path");
        path.setAttribute("d", "M9 6l6 6l-6 6");
        icon.append(path);
        return icon;
      };
      // Both labels share one grid cell, so switching them never resizes the toggle.
      const quoteLabels = () => {
        const labels = document.createElement("span");
        labels.className = "mail-quoted-labels";
        for (const [state, text] of [["show", quotedTextLabels.show], ["hide", quotedTextLabels.hide]]) {
          const label = document.createElement("span");
          label.className = "mail-quoted-" + state;
          label.textContent = text;
          labels.append(label);
        }
        return labels;
      };
      const quoteSelectors = 'blockquote[type="cite"], .gmail_quote, .yahoo_quoted';
      const candidates = [...document.querySelectorAll(quoteSelectors)].filter((node) => !node.parentElement?.closest("details.mail-quoted-history"));
      // The parent remembers opened quotes and reopens them after a reload.
      const quotes = [];
      for (const node of candidates) {
        if (node.parentElement?.closest(quoteSelectors)) continue;
        const details = document.createElement("details");
        details.className = "mail-quoted-history";
        const summary = document.createElement("summary");
        summary.append(quoteChevron(), quoteLabels());
        node.replaceWith(details);
        details.append(summary, node);
        const index = quotes.push(details) - 1;
        details.addEventListener("toggle", () => post("quote", { index, open: details.open }));
      }
      const openQuotes = (indexes) => {
        if (!Array.isArray(indexes)) return;
        for (const index of indexes) if (Number.isSafeInteger(index) && quotes[index]) quotes[index].open = true;
      };
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
      // The parent delivers permission-checked image bytes; object URLs must
      // be created here because this opaque origin cannot load parent blob URLs.
      const shownImages = new Set();
      const showImages = (entries) => {
        if (!Array.isArray(entries)) return;
        for (const entry of entries) {
          const attribute = entry?.kind === "cid" ? "data-mail-cid" : entry?.kind === "remote" ? "data-mail-remote-image" : "";
          if (!attribute || typeof entry.id !== "string" || !(entry.image instanceof Blob)) continue;
          const key = entry.kind + ":" + entry.id;
          if (shownImages.has(key)) continue;
          shownImages.add(key);
          const url = URL.createObjectURL(entry.image);
          for (const image of document.querySelectorAll("img[" + attribute + "]")) {
            if (image.getAttribute(attribute).toLowerCase() === entry.id) image.src = url;
          }
        }
      };
      addEventListener("message", (event) => {
        const data = event.data;
        if (event.source !== parent || !data || data.source !== "cloud-mail-host" || data.channel !== channel) return;
        if (data.type === "measure") reportHeight();
        if (data.type === "images") showImages(data.value);
        if (data.type === "quotes") openQuotes(data.value);
      });
      if (root) new ResizeObserver(reportHeight).observe(root);
      reportHeight();
    })();
  </script>
</body>
</html>`;
};
