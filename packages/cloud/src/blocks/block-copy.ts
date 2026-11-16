/**
 * What a block puts on the clipboard and what it downloads: a table as text with tabs and as an HTML table (so it pastes
 * into a mail and into a spreadsheet), a chart as a picture, key figures as name and value per line.
 */
export type BlockCopy = { text: string; html?: string } | { image: () => Promise<Blob> };

const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const tsvCell = (value: string) => value.replace(/[\t\r\n]+/g, " ");

export const tableCopy = (columns: readonly string[], rows: readonly (readonly string[])[]): BlockCopy => ({
  text: [columns, ...rows].map((row) => row.map(tsvCell).join("\t")).join("\n"),
  html: `<table><thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`,
});

export const figuresCopy = (items: readonly { label: string; value: string }[]): BlockCopy => ({
  text: items.map((item) => `${tsvCell(item.label)}\t${tsvCell(item.value)}`).join("\n"),
});

const csvCell = (value: string) => (/[",\r\n;]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
export const tableCsv = (columns: readonly string[], rows: readonly (readonly string[])[]) =>
  new Blob([`﻿${[columns, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`], { type: "text/csv;charset=utf-8" });

/** A drawn chart's SVG as a PNG at twice its size, on the page's surface so it reads on any paste target. */
export const chartImage = async (svg: string, size: { width: number; height: number }): Promise<Blob> => {
  const scale = 2;
  const sized = svg.replace(/<svg\b/, `<svg width="${size.width}" height="${size.height}"`);
  const url = URL.createObjectURL(new Blob([sized], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(size.width * scale);
    canvas.height = Math.round(size.height * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No canvas");
    context.fillStyle = getComputedStyle(document.body).getPropertyValue("--k2b-surface").trim() || "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("No picture"))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
};

/** Writes a copy to the clipboard: a picture, or text with its HTML where the browser takes both. */
export const writeBlockCopy = async (copy: BlockCopy | Promise<BlockCopy>) => {
  const value = await copy;
  if ("image" in value) {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": value.image() })]);
    return;
  }
  if (value.html && typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([value.text], { type: "text/plain" }),
        "text/html": new Blob([value.html], { type: "text/html" }),
      }),
    ]);
    return;
  }
  await navigator.clipboard.writeText(value.text);
};

/** Saves a file the page made itself. */
export const saveBlob = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
};

/** A file name from a block's title, safe on every system. */
export const blockFileName = (title: string, extension: string) =>
  `${
    title
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
      .trim()
      .slice(0, 80) || "export"
  }.${extension}`;

/**
 * The whole table of a block, read from the page as it is formatted: a frame's hidden full copy, which keeps its height,
 * holds every row; without one, the shown table. A search narrows only what the reader sees, never what Copy takes.
 */
export const wholeTable = (root: Element | null | undefined): { columns: string[]; rows: string[][] } => {
  const tables = Array.from(root?.querySelectorAll("table") ?? []);
  const table =
    root?.querySelector(".k2b-dashboard-frame__reserve table") ?? tables.find((candidate) => !candidate.closest('[aria-hidden="true"]'));
  const cells = (row: Element) => Array.from(row.children).map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim());
  const head = table?.querySelector("thead tr");
  return {
    columns: head ? cells(head) : [],
    rows: Array.from(table?.querySelectorAll("tbody tr") ?? []).map(cells),
  };
};
