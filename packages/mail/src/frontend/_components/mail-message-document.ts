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

export type MessageAppearanceMode = "light" | "dark" | "auto";

export type QuotedTextLabels = { show: string; hide: string };

export const buildMessageDocument = (
  html: string,
  channel: string,
  linksDisabled = false,
  locale = "en",
  quotedTextLabels: QuotedTextLabels = { show: "Show quoted text", hide: "Hide quoted text" },
  initialMode: MessageAppearanceMode = "light",
): string => {
  const initialModeLiteral = JSON.stringify(initialMode).replaceAll("<", "\\u003c");
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
    html:not(.mail-dark) { color-scheme: only light; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; color: #18181b; font: 14px/1.55 system-ui, sans-serif; overflow-wrap: anywhere; }
    html.mail-dark { color-scheme: dark; }
    html.mail-dark, html.mail-dark body { background: transparent; color: var(--mail-dark-text, #f4f4f5); }
    html.mail-dark a { color: var(--mail-dark-link); }
    body { padding: 1px; }
    img { max-width: 100%; height: auto; }
    table { max-width: 100%; border-collapse: collapse; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    a { color: #1677c8; }
    details.mail-quoted-history { margin-top: 12px; }
    details.mail-quoted-history > :not(summary),
    details.mail-quoted-history > summary { color: var(--mail-quote-text, color-mix(in srgb, currentColor 65%, transparent)); }
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
    details.mail-quoted-history > div { margin: 8px 0 0; padding-left: 12px; border-left: 2px solid var(--mail-quote-border, color-mix(in srgb, currentColor 25%, transparent)); }
    #mail-message-root { display: flow-root; min-height: 0; }
  </style>
</head>
<body><div id="mail-message-root">${html}</div>
  <script nonce="${scriptNonce}">
    (() => {
      "use strict";
      const channel = ${channelLiteral};
      const initialMode = ${initialModeLiteral};
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
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const parsedColors = new Map();
      const parseColor = (value) => {
        if (!parsedColors.has(value)) {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = "rgba(0, 0, 0, 0)";
          context.fillStyle = value;
          context.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
          parsedColors.set(value, [r, g, b, a / 255]);
        }
        return parsedColors.get(value);
      };
      const cssColor = ([r, g, b, a]) => "rgba(" + [Math.round(r), Math.round(g), Math.round(b), a].join(", ") + ")";
      const luminance = (color) => {
        const linear = color.slice(0, 3).map((value) => {
          const c = value / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
      };
      const contrast = (first, second) => {
        const a = luminance(first), b = luminance(second);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      };
      const rgbToHsl = (color) => {
        const [r, g, b] = color.map((value) => value / 255);
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const delta = max - min, lightness = (max + min) / 2;
        if (delta === 0) return [0, 0, lightness];
        const hue = max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
        return [hue / 6, delta / (1 - Math.abs(2 * lightness - 1)), lightness];
      };
      const hslToRgb = ([h, s, l], alpha) => {
        const chroma = (1 - Math.abs(2 * l - 1)) * s;
        const x = chroma * (1 - Math.abs((h * 6) % 2 - 1));
        const sector = Math.floor(h * 6) % 6;
        const rgb = [[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x]][sector];
        return [...rgb.map((value) => Math.round((value + l - chroma / 2) * 255)), alpha];
      };
      const mix = (first, second, amount) => [
        ...first.slice(0, 3).map((value, index) => value * (1 - amount) + second[index] * amount),
        second[3],
      ];
      let background = parseColor("#11151b");
      let text = parseColor("#f4f4f5");
      const adaptBackground = (color) => {
        if (luminance(color) <= 0.4) return color;
        const [h, s, l] = rgbToHsl(color);
        return mix(background, hslToRgb([h, s * 0.6, 0.35], color[3]), Math.max(0, Math.min((1 - l) * 2.5, 1)));
      };
      const adaptText = (color, effectiveBackground) => {
        // Translucent text shows its surface through, so judge and adapt the color as painted.
        const painted = color[3] < 1 ? [...mix(effectiveBackground, color, color[3]).slice(0, 3), 1] : color;
        if (contrast(painted, effectiveBackground) >= 4.5) return color;
        const [h, s, l] = rgbToHsl(painted);
        let lightness = 1 - l;
        let result = hslToRgb([h, s, lightness], 1);
        // Mid-tone surfaces reach more contrast with dark text, so move toward the stronger extreme.
        const direction = contrast([255, 255, 255], effectiveBackground) >= contrast([0, 0, 0], effectiveBackground) ? 1 : -1;
        while (contrast(result, effectiveBackground) < 4.5 && (direction > 0 ? lightness < 1 : lightness > 0)) {
          lightness = Math.max(0, Math.min(1, lightness + direction * 0.05));
          result = hslToRgb([h, s, lightness], 1);
        }
        return result;
      };
      const white = parseColor("rgb(255, 255, 255)");
      // Light mode never changes the document, so the analysis waits for the first dark apply.
      let originals = null;
      const captureOriginals = () => {
        const elements = [root, ...root.querySelectorAll("*")];
        // Sentinels tell inherited defaults apart from the sender's own colors. The quote
        // dimming is the frame's own rule, so it follows the sentinel during the capture.
        const bodyStyle = document.body.getAttribute("style");
        document.body.style.color = "rgb(1, 2, 3)";
        const sentinel = document.createElement("style");
        // Transitions are off so computed colors show the sentinel at once.
        sentinel.textContent =
          ":root { --mail-quote-text: currentColor; --mail-quote-border: currentColor; } * { transition: none !important; } a { color: rgb(1, 2, 4); }";
        document.head.append(sentinel);
        const captured = new Map();
        for (const element of elements) {
          const computed = getComputedStyle(element);
          const color = computed.color;
          const fill = parseColor(computed.backgroundColor);
          // Borders and decorations without their own color follow the text and need no change.
          const own = (value) => (value === color ? null : parseColor(value));
          const borders = [];
          for (const side of ["top", "right", "bottom", "left"]) {
            const width = parseFloat(computed.getPropertyValue("border-" + side + "-width"));
            const style = computed.getPropertyValue("border-" + side + "-style");
            const border = own(computed.getPropertyValue("border-" + side + "-color"));
            if (border && width > 0 && !["none", "hidden"].includes(style)) borders.push(["border-" + side + "-color", border]);
          }
          captured.set(element, {
            style: element.getAttribute("style"),
            color: color === "rgb(1, 2, 3)" || color === "rgb(1, 2, 4)" ? null : parseColor(color),
            decoration: own(computed.textDecorationColor),
            textShadow: computed.textShadow !== "none",
            background: fill[3] > 0 ? fill : null,
            backgroundImage: computed.backgroundImage !== "none",
            borders,
          });
        }
        sentinel.remove();
        if (bodyStyle === null) document.body.removeAttribute("style");
        else document.body.setAttribute("style", bodyStyle);
        return captured;
      };
      const effectiveBackground = (element, adapted) => {
        const layers = [];
        for (let current = element; current; current = current.parentElement) {
          const original = originals.get(current);
          // An unchanged image makes the adapted surface below the text unknown.
          if (adapted && original?.backgroundImage) return null;
          if (!original?.background) continue;
          layers.push(adapted ? adaptBackground(original.background) : original.background);
          if (original.background[3] === 1) break;
        }
        const surface = layers.reverse().reduce((below, layer) => mix(below, layer, layer[3]), adapted ? background : white);
        return [...surface.slice(0, 3), 1];
      };
      const imageAnalysis = new Map();
      const needsImagePlate = (image) => {
        const analysis = imageAnalysis.get(image);
        if (!analysis || analysis.transparentShare < 0.05 || analysis.opaqueColors.length === 0) return false;
        const darkInk = analysis.opaqueColors.filter((color) => contrast(color, background) < 3).length;
        return darkInk >= analysis.opaqueColors.length * 0.3;
      };
      const foregrounds = new Map();
      let currentMode = "light";
      const restoreStyle = (element, original) => {
        // Reading first flushes pending inline style writes, which engines may otherwise serialize back as style="".
        if (element.getAttribute("style") === original.style) return;
        if (original.style === null) element.removeAttribute("style");
        else element.setAttribute("style", original.style);
      };
      const applyDarkStyles = (element, original) => {
        restoreStyle(element, original);
        const set = (property, value) => element.style.setProperty(property, cssColor(value), "important");
        const effective = effectiveBackground(element, true);
        const isLink = element.tagName === "A";
        if (effective === null) {
          // A background image stays as authored, so it and everything on it keep the light design and surface.
          // Only the outermost image gets a backing; nested ones already sit on the preserved design.
          if (original.backgroundImage && effectiveBackground(element.parentElement, true) !== null) {
            set("background-color", effectiveBackground(element, false));
          }
          const color = original.color || parseColor(isLink ? "#1677c8" : "#18181b");
          set("color", color);
          foregrounds.set(element, color);
          return;
        }
        if (original.background) set("background-color", adaptBackground(original.background));
        for (const [property, color] of original.borders) set(property, adaptBackground(color));
        const inherited = foregrounds.get(element.parentElement) || text;
        // Quoted history is dimmed by the frame's own rule, which keeps following the adapted text.
        const quotePart = element.parentElement?.matches("details.mail-quoted-history");
        const base = original.color || (isLink
          ? parseColor(document.documentElement.style.getPropertyValue("--mail-dark-link"))
          : quotePart ? [...inherited.slice(0, 3), inherited[3] * 0.65] : inherited);
        const color = adaptText(base, effective);
        if (original.color || color !== base) set("color", color);
        foregrounds.set(element, color);
        if (original.decoration) set("text-decoration-color", adaptText(original.decoration, effective));
        // A shadow drawn for light text on a light surface turns into a halo around adapted text.
        if (original.textShadow && cssColor(color) !== cssColor(original.color || parseColor("#18181b"))) {
          element.style.setProperty("text-shadow", "none", "important");
        }
        if (needsImagePlate(element)) {
          const originalEffective = effectiveBackground(element, false);
          if (luminance(originalEffective) > 0.4 && cssColor(effective) !== cssColor(originalEffective)) {
            set("background-color", originalEffective);
          }
        }
      };
      const analyzeImage = (image) => {
        if (!image.complete || image.naturalWidth === 0) return;
        let analysis = null;
        try {
          const sample = document.createElement("canvas");
          const scale = Math.min(1, 64 / Math.max(image.naturalWidth, image.naturalHeight));
          sample.width = Math.max(1, Math.round(image.naturalWidth * scale));
          sample.height = Math.max(1, Math.round(image.naturalHeight * scale));
          const pixels = sample.getContext("2d", { willReadFrequently: true });
          pixels.drawImage(image, 0, 0, sample.width, sample.height);
          const data = pixels.getImageData(0, 0, sample.width, sample.height).data;
          let transparent = 0;
          const opaqueColors = [];
          for (let index = 0; index < data.length; index += 4) {
            if (data[index + 3] < 128) transparent++;
            else opaqueColors.push([data[index], data[index + 1], data[index + 2]]);
          }
          analysis = { transparentShare: transparent / (sample.width * sample.height), opaqueColors };
        } catch {
          // Unreadable pixels leave the image unchanged.
        }
        imageAnalysis.set(image, analysis);
      };
      const images = [...root.querySelectorAll("img")];
      for (const image of images) {
        image.addEventListener("load", () => {
          // Pixels are read only for dark mode; a later dark apply reads the new source.
          imageAnalysis.delete(image);
          if (currentMode !== "dark") return;
          analyzeImage(image);
          applyDarkStyles(image, originals.get(image));
        });
      }
      const applyMode = (mode) => {
        currentMode = mode;
        foregrounds.clear();
        // The capture reads the light document, so it runs before the dark class applies.
        if (mode === "dark") originals ??= captureOriginals();
        document.documentElement.classList.toggle("mail-dark", mode === "dark");
        if (mode === "dark") {
          for (const image of images) if (!imageAnalysis.has(image)) analyzeImage(image);
          document.documentElement.style.setProperty("--mail-dark-text", cssColor(text));
          document.documentElement.style.setProperty("--mail-dark-link", cssColor(adaptText(parseColor("#1677c8"), background)));
          for (const [element, original] of originals) applyDarkStyles(element, original);
        } else {
          for (const [element, original] of originals ?? []) restoreStyle(element, original);
          document.documentElement.style.removeProperty("--mail-dark-text");
          document.documentElement.style.removeProperty("--mail-dark-link");
        }
        reportHeight();
      };
      const setAppearance = (value) => {
        if (!value || (value.mode !== "light" && value.mode !== "dark")) return;
        const validColor = (color) => color === null || (typeof color === "string" && color.length < 200);
        if (!validColor(value.text) || !validColor(value.background)) return;
        text = parseColor(value.text || "#f4f4f5");
        background = parseColor(value.background || "#11151b");
        applyMode(value.mode);
      };
      applyMode(initialMode === "auto" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : initialMode);
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
        if (data.type === "appearance") setAppearance(data.value);
      });
      if (root) new ResizeObserver(reportHeight).observe(root);
      reportHeight();
    })();
  </script>
</body>
</html>`;
};
