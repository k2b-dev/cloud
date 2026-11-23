// ==========================
// Headless Syntax Highlighting
// ==========================
//
// Small string-to-HTML helpers for textarea overlays, markdown previews, and
// project-specific DSLs. No DOM, no CSS, no themes, no parser dependencies.

export type Highlighter = (text: string) => string;

export type HighlightRule = {
  /** Semantic token kind. Rendered as `${classPrefix}${kind}` after sanitising. */
  kind: string;
  /** Regex matched at the current cursor position. Rule order is priority. */
  match: RegExp;
};

export type CompileOptions = {
  /** Prefix for generated token classes. Default: `"hl-"`. */
  classPrefix?: string;
};

export type MarkdownOptions = {
  /** Standalone labels to wrap in `md-completion-match` outside code zones. */
  knownLabels?: ReadonlySet<string>;
};

export type OverlayOptions = {
  /** Inline completion preview inserted at `at`. */
  ghost?: { at: number; text: string };
  /** Invisible caret anchor inserted at `at` when no ghost is visible. */
  anchor?: { at: number };
};

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const sanitizeClassPart = (s: string): string => {
  const clean = s.replace(/[^a-zA-Z0-9_-]/g, "-");
  let start = 0;
  let end = clean.length;
  while (start < end && clean[start] === "-") start++;
  while (end > start && clean[end - 1] === "-") end--;
  return clean.slice(start, end) || "token";
};

const compileRegex = (regex: RegExp): RegExp => {
  const flags = new Set(regex.flags.replace(/[gy]/g, "").split(""));
  flags.add("y");
  return new RegExp(regex.source, [...flags].sort().join(""));
};

type PresetRule = HighlightRule & {
  // Only known delimiter rules opt into caching failed suffix scans.
  delimiters?: readonly { open: string; emptyClose?: string; lineBounded?: boolean }[];
};

const createHighlighter = (
  rules: readonly PresetRule[],
  options: CompileOptions = {},
): Highlighter => {
  const classPrefix = options.classPrefix ?? "hl-";
  const compiled = rules.map((rule) => ({
    className: `${classPrefix}${sanitizeClassPart(rule.kind)}`,
    match: compileRegex(rule.match),
    delimiters: rule.delimiters,
  }));

  return (text: string): string => {
    if (text.length === 0) return "";
    if (compiled.length === 0) return escapeHtml(text);

    let html = "";
    let pos = 0;
    let plainStart = 0;
    const failedUntil = compiled.map(() => new Map<string, number>());

    const flushPlain = (end: number): void => {
      if (end > plainStart) html += escapeHtml(text.slice(plainStart, end));
    };

    while (pos < text.length) {
      let token: { className: string; value: string } | null = null;

      for (const [index, rule] of compiled.entries()) {
        const delimiter = rule.delimiters?.find(({ open }) => text.startsWith(open, pos));
        const failures = failedUntil[index]!;
        if (delimiter && pos < (failures.get(delimiter.open) ?? 0)) continue;

        rule.match.lastIndex = pos;
        const match = rule.match.exec(text);
        if (match && match.index === pos && match[0].length > 0) {
          token = { className: rule.className, value: match[0] };
          break;
        }
        if (delimiter && (!delimiter.emptyClose || !text.startsWith(delimiter.emptyClose, pos + delimiter.open.length))) {
          const newline = delimiter.lineBounded ? text.indexOf("\n", pos + delimiter.open.length) : -1;
          failures.set(delimiter.open, newline < 0 ? text.length : newline);
        }
      }

      if (token) {
        flushPlain(pos);
        html += `<span class="${token.className}">${escapeHtml(token.value)}</span>`;
        pos += token.value.length;
        plainStart = pos;
      } else {
        pos++;
      }
    }

    flushPlain(text.length);
    return html;
  };
};

const compileHighlighter = (
  rules: readonly HighlightRule[],
  options: CompileOptions = {},
): Highlighter => createHighlighter(rules, options);

// A failed delimited match has no closer in its remaining input (or line).
// Cache that boundary per opener so escaped quotes and nested openers cannot
// trigger the same suffix scan again. Keep the complete-token rules unchanged.
// Block comments instead consume through absolute EOF, including a final newline.
const codeHighlighter = createHighlighter([
  { kind: "comment", match: /\/\*[\s\S]*?(?:\*\/|(?![\s\S]))/ },
  { kind: "comment", match: /\/\/[^\n]*/ },
  { kind: "string", match: /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/, delimiters: [{ open: '"' }, { open: "'" }, { open: "`" }] },
  { kind: "number", match: /\b\d+(?:\.\d+)?\b/ },
  {
    kind: "keyword",
    match:
      /\b(?:as|async|await|break|case|catch|class|const|continue|default|delete|do|else|export|extends|false|finally|for|from|function|if|import|in|instanceof|let|new|null|of|return|switch|this|throw|true|try|type|typeof|undefined|var|void|while|yield)\b/,
  },
  { kind: "operator", match: /=>|===|!==|==|!=|<=|>=|\+\+|--|&&|\|\||[+\-*/%=&|!<>?:.]+/ },
]);

const shellHighlighter = createHighlighter([
  { kind: "comment", match: /#[^\n]*/ },
  { kind: "string", match: /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/, delimiters: [{ open: '"' }, { open: "'" }] },
  { kind: "variable", match: /\$(?:[a-zA-Z_][a-zA-Z0-9_]*|\{[^}\n]+\}|[0-9*@#$?!-])/, delimiters: [{ open: "${", emptyClose: "}", lineBounded: true }] },
  {
    kind: "keyword",
    match:
      /\b(?:case|coproc|do|done|elif|else|esac|fi|for|function|if|in|select|then|time|until|while)\b/,
  },
  { kind: "operator", match: /&&|\|\||;;|[|&;()<>]/ },
]);

const sqlHighlighter = createHighlighter([
  { kind: "comment", match: /\/\*[\s\S]*?(?:\*\/|(?![\s\S]))/ },
  { kind: "comment", match: /--[^\n]*/ },
  { kind: "string", match: /'(?:''|\\[\s\S]|[^'\\])*'/, delimiters: [{ open: "'" }] },
  { kind: "identifier", match: /"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`|\[[^\]\n]+\]/, delimiters: [{ open: '"' }, { open: "`" }, { open: "[", emptyClose: "]", lineBounded: true }] },
  { kind: "parameter", match: /\$(?:\d+|[a-zA-Z_][a-zA-Z0-9_]*)|:[a-zA-Z_][a-zA-Z0-9_]*|@[a-zA-Z_][a-zA-Z0-9_]*|\?(?!\?)/ },
  { kind: "number", match: /\b\d+(?:\.\d+)?\b/ },
  {
    kind: "keyword",
    match:
      /\b(?:add|all|alter|and|as|asc|between|by|case|check|constraint|create|cross|default|delete|desc|distinct|drop|else|end|exists|false|foreign|from|full|group|having|in|inner|insert|intersect|into|is|join|key|left|like|limit|null|not|offset|on|or|order|outer|primary|references|returning|right|select|set|table|then|true|union|unique|update|values|when|where|with)\b/i,
  },
  { kind: "function", match: /\b[a-zA-Z_][a-zA-Z0-9_]*(?=\s*\()/ },
  { kind: "operator", match: /<>|!=|<=|>=|->>|->|::|\|\||[=<>+\-*/%,.;()]/ },
]);

// Private Use Area chars for markdown sanctuary placeholders.
const PH_OPEN = String.fromCharCode(0xe000);
const PH_CLOSE = String.fromCharCode(0xe001);
const BOLD_PH_OPEN = String.fromCharCode(0xe002);
const BOLD_PH_CLOSE = String.fromCharCode(0xe003);
const MATCH_PH_OPEN = String.fromCharCode(0xe004);
const MATCH_PH_CLOSE = String.fromCharCode(0xe005);
const OVERLAY_SENTINEL = String.fromCharCode(0xe010);

type Sanctuaries = Map<string, string>;

const extractMarkdownSanctuaries = (
  input: string,
): { text: string; sanctuaries: Sanctuaries } => {
  const sanctuaries: Sanctuaries = new Map();
  let counter = 0;
  const issue = (): string => `${PH_OPEN}${counter++}${PH_CLOSE}`;

  let text = input;

  text = text.replace(/(?<!`)(`+)(?!`)([^\n]+?)\1(?!`)/g, (_match, ticks: string, content: string) => {
    const ph = issue();
    sanctuaries.set(
      ph,
      `<span class="md-code"><span class="md-syntax">${ticks}</span>${content}<span class="md-syntax">${ticks}</span></span>`,
    );
    return ph;
  });

  text = text.replace(/\[([^\]\n]+?)\]\(([^)\n]+?)\)/g, (_match, label: string, url: string) => {
    const ph = issue();
    sanctuaries.set(
      ph,
      `<span class="md-link"><span class="md-syntax">[</span>${label}<span class="md-syntax">](${url})</span></span>`,
    );
    return ph;
  });

  return { text, sanctuaries };
};

const restoreSanctuaries = (html: string, sanctuaries: Sanctuaries): string => {
  for (const [ph, replacement] of [...sanctuaries].reverse()) {
    if (html.includes(ph)) html = html.split(ph).join(replacement);
  }
  return html;
};

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildMatchRegex = (labels: ReadonlySet<string>): RegExp | null => {
  if (labels.size === 0) return null;
  const sorted = [...labels].sort((a, b) => b.length - a.length).map(escapeRegex);
  return new RegExp(`(?<![\\p{L}\\p{N}_])(${sorted.join("|")})(?![\\p{L}\\p{N}_])`, "gu");
};

const processItalic = (text: string): string => {
  text = text.replace(
    /(^|[^*\w])\*([^\s*][^*\n]*?[^\s*]|[^\s*])\*(?!\*)/g,
    '$1<span class="md-italic"><span class="md-syntax">*</span>$2<span class="md-syntax">*</span></span>',
  );
  text = text.replace(
    /(^|[^\w_])_([^\s_][^_\n]*?[^\s_]|[^\s_])_(?!\w)/g,
    '$1<span class="md-italic"><span class="md-syntax">_</span>$2<span class="md-syntax">_</span></span>',
  );
  return text;
};

const processItalicAndMatches = (text: string, matchRegex: RegExp | null): string => {
  if (!matchRegex) return processItalic(text);

  const matchSanctuary = new Map<string, string>();
  let counter = 0;
  const issue = (): string => `${MATCH_PH_OPEN}${counter++}${MATCH_PH_CLOSE}`;

  matchRegex.lastIndex = 0;
  text = text.replace(matchRegex, (label: string) => {
    const ph = issue();
    matchSanctuary.set(ph, `<span class="md-completion-match">${label}</span>`);
    return ph;
  });

  text = processItalic(text);

  for (const [ph, html] of matchSanctuary) {
    if (text.includes(ph)) text = text.split(ph).join(html);
  }
  return text;
};

const processInline = (text: string, matchRegex: RegExp | null = null): string => {
  const sanctuaries = new Map<string, string>();
  let counter = 0;
  const issue = (): string => `${BOLD_PH_OPEN}${counter++}${BOLD_PH_CLOSE}`;

  text = text.replace(/\*\*((?:[^*\n]|\*[^*\n]+?\*)+?)\*\*/g, (_match, inner: string) => {
    const innerProcessed = processItalicAndMatches(inner, matchRegex);
    const ph = issue();
    sanctuaries.set(
      ph,
      `<span class="md-bold"><span class="md-syntax">**</span>${innerProcessed}<span class="md-syntax">**</span></span>`,
    );
    return ph;
  });

  text = text.replace(/__((?:[^_\n]|_[^_\n]+?_)+?)__/g, (_match, inner: string) => {
    const innerProcessed = processItalicAndMatches(inner, matchRegex);
    const ph = issue();
    sanctuaries.set(
      ph,
      `<span class="md-bold"><span class="md-syntax">__</span>${innerProcessed}<span class="md-syntax">__</span></span>`,
    );
    return ph;
  });

  text = processItalicAndMatches(text, matchRegex);

  for (const [ph, html] of sanctuaries) {
    if (text.includes(ph)) text = text.split(ph).join(html);
  }
  return text;
};

const processLine = (line: string, matchRegex: RegExp | null = null): string => {
  if (line.length === 0) return "";

  const header = /^(#{1,3})(\s)(.*)$/.exec(line);
  if (header) {
    const [, hashes, ws, content] = header;
    return `<span class="md-h${hashes!.length}"><span class="md-syntax">${hashes}${ws}</span>${processInline(content!, matchRegex)}</span>`;
  }

  if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
    return `<span class="md-hr">${line}</span>`;
  }

  const quote = /^(&gt;)(\s)(.*)$/.exec(line);
  if (quote) {
    return `<span class="md-quote"><span class="md-syntax">${quote[1]}${quote[2]}</span>${processInline(quote[3]!, matchRegex)}</span>`;
  }

  const bullet = /^(\s*)([-*+])(\s)(.*)$/.exec(line);
  if (bullet) {
    const [, indent, marker, ws, content] = bullet;
    return `${indent}<span class="md-marker">${marker}${ws}</span>${processInline(content!, matchRegex)}`;
  }

  const numbered = /^(\s*)(\d+\.)(\s)(.*)$/.exec(line);
  if (numbered) {
    const [, indent, marker, ws, content] = numbered;
    return `${indent}<span class="md-marker">${marker}${ws}</span>${processInline(content!, matchRegex)}`;
  }

  return processInline(line, matchRegex);
};

const markdownHighlighter = (text: string, options: MarkdownOptions = {}): string => {
  const matchRegex = options.knownLabels ? buildMatchRegex(options.knownLabels) : null;
  const escaped = escapeHtml(text);
  const { text: protectedText, sanctuaries } = extractMarkdownSanctuaries(escaped);

  const lines = protectedText.split("\n");
  const out: string[] = [];
  let inCodeFence = false;

  for (const line of lines) {
    if (/^```/.test(line)) {
      inCodeFence = !inCodeFence;
      out.push(`<span class="md-code-block md-syntax">${line}</span>`);
      continue;
    }
    if (inCodeFence) {
      out.push(`<span class="md-code-block">${line}</span>`);
      continue;
    }
    out.push(processLine(line, matchRegex));
  }

  const html = restoreSanctuaries(out.join("\n"), sanctuaries);
  return text.endsWith("\n") ? `${html}\n` : html;
};

const overlay = (
  text: string,
  render: (text: string) => string,
  options: OverlayOptions = {},
): string => {
  const injection = options.ghost ?? options.anchor;
  let workText = text;

  if (injection) {
    const at = Math.max(0, Math.min(injection.at, text.length));
    workText = text.slice(0, at) + OVERLAY_SENTINEL + text.slice(at);
  }

  let html = render(workText);

  if (options.ghost) {
    const ghostHtml = `<span class="completion-ghost" data-completion-anchor>${escapeHtml(options.ghost.text)}<span class="completion-ghost-arrow" aria-hidden="true">→</span></span>`;
    html = html.split(OVERLAY_SENTINEL).join(ghostHtml);
  } else if (options.anchor) {
    const anchorHtml = `<span class="completion-caret-anchor" data-completion-anchor aria-hidden="true">​</span>`;
    html = html.split(OVERLAY_SENTINEL).join(anchorHtml);
  }

  return html;
};

export const highlight = {
  escape: escapeHtml,
  markdown: markdownHighlighter,
  overlay,
  compile: compileHighlighter,
  presets: {
    shell: shellHighlighter,
    code: codeHighlighter,
    sql: sqlHighlighter,
  },
} as const;
