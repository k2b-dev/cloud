import type { EditorView } from "@codemirror/view";
import type { EditorAction, markdownActions, SlashAction } from "@k2b/editor";
import type { messages } from "../i18n";

/** Puts a block on its own lines at the caret and leaves the caret at `caret` characters into it. */
const insertBlock = (view: EditorView, block: string, caret: number, separate = true) => {
  const at = view.state.selection.main.head;
  const line = view.state.doc.lineAt(at);
  const filled = line.text.trim().length > 0;
  // A blank line keeps a divider from turning the text above it into a heading.
  const above = line.number > 1 && view.state.doc.line(line.number - 1).text.trim().length > 0;
  const lead = filled ? "\n\n" : separate && above ? "\n" : "";
  const from = filled ? line.to : line.from;
  view.dispatch({ changes: { from, to: line.to, insert: `${lead}${block}` }, selection: { anchor: from + lead.length + caret } });
  view.focus();
};

const seriesChart = (type: "line" | "bar" | "scatter", title: string) =>
  `:::chart\ntype: ${type}\ntitle: ${title}\ncolumns: [A, B]\nrows:\n  - [1, 10]\n  - [2, 20]\nx: A\ny: B\n:::\n`;
const shareChart = (type: "pie" | "donut", title: string) =>
  `:::chart\ntype: ${type}\ntitle: ${title}\ncolumns: [A, B]\nrows:\n  - [X, 10]\n  - [Y, 20]\nlabel: A\nvalue: B\n:::\n`;
const callout = (type: string) => `:::${type}\n\n:::\n`;

/**
 * Every block the Notes presentation renders, text first, then lists, then blocks and media. Formulas in fences and
 * Mermaid stay out: Notes loads neither renderer, so they would show as raw code. Actions stay off inside a table
 * cell, where a block would split the row. Names are what a person types; both languages match.
 */
export const noteSlashActions = (options: {
  t: ReturnType<typeof messages.resolve>["t"];
  md: ReturnType<typeof markdownActions>;
  tag: EditorAction;
  inCell: () => boolean;
  pickFiles: () => void;
}): SlashAction[] => {
  const { t, md, tag, inCell, pickFiles } = options;
  const actions: SlashAction[] = [
    { ...md.heading1, name: "h1", aliases: ["heading1", "title", "titel", "ueberschrift1", "überschrift1"], label: t.slashHeading1 },
    {
      ...md.heading2,
      name: "ueberschrift",
      aliases: ["h2", "heading", "heading2", "überschrift", "ueberschrift2"],
      label: t.slashHeading2,
    },
    { ...md.heading3, name: "h3", aliases: ["heading3", "ueberschrift3", "überschrift3"], label: t.slashHeading3 },
    { ...md.quote, name: "quote", aliases: ["zitat", "blockquote"], label: t.slashQuote },
    { ...md.link, name: "link", aliases: ["url", "verknuepfung", "verknüpfung"], label: t.fmtLink, inline: true },
    { ...tag, name: "tag", aliases: ["schlagwort", "hashtag"], label: t.fmtTag, description: t.slashTagHint, inline: true },

    { ...md.bulletList, name: "list", aliases: ["bullet", "ul", "liste", "aufzaehlung", "aufzählung"], label: t.slashBullet },
    { ...md.numberedList, name: "numbered", aliases: ["ol", "ordered", "nummeriert", "nummern"], label: t.slashNumbered },
    {
      id: "checklist",
      name: "checkliste",
      aliases: ["checklist", "todo", "task", "aufgabe"],
      icon: "ti-list-check",
      label: t.fmtTask,
      run: (view) => insertBlock(view, "- [ ] ", 6, false),
    },

    { ...md.table, name: "tabelle", aliases: ["table"], label: t.slashTable },
    {
      id: "note",
      name: "hinweis",
      aliases: ["note", "callout"],
      icon: "ti-chevron-right",
      label: t.slashNote,
      description: t.slashNoteHint,
      run: (view) => insertBlock(view, callout("note"), 8),
    },
    {
      id: "info",
      name: "info",
      aliases: ["tipp", "tip"],
      icon: "ti-info-circle",
      label: t.slashInfo,
      run: (view) => insertBlock(view, callout("info"), 8),
    },
    {
      id: "success",
      name: "success",
      aliases: ["erfolg", "ok"],
      icon: "ti-check",
      label: t.slashSuccess,
      run: (view) => insertBlock(view, callout("success"), 11),
    },
    {
      id: "warning",
      name: "warning",
      aliases: ["warnung", "warn"],
      icon: "ti-alert-circle",
      label: t.slashWarning,
      run: (view) => insertBlock(view, callout("warning"), 11),
    },
    {
      id: "danger",
      name: "danger",
      aliases: ["gefahr", "error"],
      icon: "ti-alert-hexagon",
      label: t.slashDanger,
      run: (view) => insertBlock(view, callout("danger"), 10),
    },
    { ...md.codeBlock, name: "code", aliases: ["codeblock", "pre", "snippet"], label: t.slashCode },
    {
      id: "divider",
      name: "divider",
      aliases: ["hr", "trennlinie", "linie", "separator"],
      icon: "ti-minus",
      label: t.slashDivider,
      run: (view) => insertBlock(view, "---\n", 4),
    },

    {
      id: "image",
      name: "bild",
      aliases: ["image", "img", "pdf", "foto", "photo"],
      icon: "ti-photo",
      label: t.fmtImage,
      description: t.slashImageHint,
      run: pickFiles,
    },
    {
      id: "chart",
      name: "diagramm",
      aliases: ["chart", "line"],
      icon: "ti-chart-line",
      label: t.slashChart,
      description: t.slashChartHint,
      run: (view) => insertBlock(view, seriesChart("line", t.slashChart), 0),
    },
    {
      id: "chart-bar",
      name: "balken",
      aliases: ["bar", "bars"],
      icon: "ti-chart-bar",
      label: t.slashBar,
      run: (view) => insertBlock(view, seriesChart("bar", t.slashChart), 0),
    },
    {
      id: "chart-pie",
      name: "kreis",
      aliases: ["pie", "torte"],
      icon: "ti-chart-pie",
      label: t.slashPie,
      run: (view) => insertBlock(view, shareChart("pie", t.slashChart), 0),
    },
    {
      id: "chart-donut",
      name: "ring",
      aliases: ["donut"],
      icon: "ti-chart-donut",
      label: t.slashDonut,
      run: (view) => insertBlock(view, shareChart("donut", t.slashChart), 0),
    },
    {
      id: "chart-scatter",
      name: "punkte",
      aliases: ["scatter", "dots"],
      icon: "ti-chart-dots",
      label: t.slashScatter,
      run: (view) => insertBlock(view, seriesChart("scatter", t.slashChart), 0),
    },
  ];
  return actions.map((action) => ({
    ...action,
    isEnabled: (state) => !inCell() && action.isEnabled?.(state) !== false,
  }));
};
