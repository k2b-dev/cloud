import { extractNamedBlocks, type NamedBlock, type NamedBlockType, namedBlockBody, parseNamedDataBlock } from "../../../lib/named-blocks";
import type {
  KitContext,
  KitDataView,
  KitListView,
  KitNote,
  KitReadableNoteBlocks,
  KitSectionView,
  KitTableView,
  KitTodoView,
  KitWritableNoteBlocks,
} from "./kit-types";

type RowInput = Record<string, unknown> | unknown[] | unknown;

const READ_MODE_WRITE_ERROR = "current named-block writes are only available in edit mode";

const requireYText = (ctx: KitContext) => {
  if (ctx.isActive && !ctx.isActive()) throw new Error("Script run is no longer active");
  if (ctx.mode !== "edit" || !ctx.ytext) throw new Error(READ_MODE_WRITE_ERROR);
  return ctx.ytext;
};

const currentContent = (ctx: KitContext): string => (ctx.ytext ? ctx.ytext.toString() : ctx.note.content);

const isKitNote = (value: unknown): value is KitNote =>
  !!value && typeof value === "object" && typeof (value as KitNote).id === "string" && typeof (value as KitNote).title === "string";

const escapeTableCell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

const normalizeTag = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
};

const normalizeMarkdownValue = (value: unknown, header?: string): string => {
  if (value === null || value === undefined) return "";
  if (isKitNote(value)) return `[${value.title}](note://${value.id})`;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) {
    const headerLooksLikeTags = header?.toLowerCase().includes("tag") ?? false;
    return value
      .map((item) => (headerLooksLikeTags && typeof item === "string" ? normalizeTag(item) : normalizeMarkdownValue(item)))
      .filter(Boolean)
      .join(" ");
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return String(value);
};

const parseDataBlock = (src: string): Record<string, unknown> => {
  return Object.fromEntries(parseNamedDataBlock(src).map(({ key, value }) => [key, value]));
};

const stringifyDataBlock = (value: Record<string, unknown>): string =>
  Object.entries(value)
    .map(([key, entry]) => {
      if (Array.isArray(entry)) {
        const items = entry.map((item) => `  - ${normalizeMarkdownValue(item)}`).join("\n");
        return `${key}:\n${items}`;
      }
      return `${key}: ${normalizeMarkdownValue(entry)}`;
    })
    .join("\n");

const splitRow = (line: string): string[] => {
  const trimmed = line.trim();
  return trimmed
    .split("|")
    .map((cell) => cell.trim())
    .filter((_, i, arr) => !((i === 0 && trimmed.startsWith("|")) || (i === arr.length - 1 && trimmed.endsWith("|"))));
};

const lineStartOffsets = (text: string): number[] => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
};

const lineAt = (text: string, line: number): string => text.split("\n")[line] ?? "";

const matchingBlocks = (text: string, type: NamedBlockType, name?: string): NamedBlock[] =>
  extractNamedBlocks(text).filter((block) => block.type === type && (name === undefined || block.name === name));

const tableRows = (text: string, block: NamedBlock): KitTableView => {
  const lines = text.split("\n");
  const columns = splitRow(lineAt(text, block.startLine));
  const rows = [];
  for (let line = block.startLine + 2; line <= block.endLine; line++) {
    const cells = splitRow(lines[line] ?? "");
    const row: Record<string, string> = {};
    columns.forEach((column, index) => {
      row[column] = cells[index] ?? "";
    });
    rows.push(row);
  }
  return { name: block.name, columns, rows };
};

const listItems = (text: string, block: NamedBlock): KitListView => {
  const body = text.slice(block.blockStart, block.blockEnd);
  const items = body
    .split("\n")
    .map((line) => line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/)?.[1]?.trim())
    .filter((item): item is string => !!item);
  return { name: block.name, items };
};

const TODO_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.+)$/;

const todoItems = (text: string, block: NamedBlock): KitTodoView => {
  const lines = text.split("\n");
  const items = [];
  for (let line = block.startLine; line <= block.endLine; line++) {
    const match = (lines[line] ?? "").match(TODO_RE);
    if (!match?.[1] || !match[2]) continue;
    items.push({ done: match[1].toLowerCase() === "x", content: match[2].trim(), line });
  }
  return { name: block.name, items };
};

const dataView = (text: string, block: NamedBlock): KitDataView => {
  const range = dataContentRange(text, block);
  return { name: block.name, value: parseDataBlock(text.slice(range.from, range.to)) };
};

const sectionView = (text: string, block: NamedBlock): KitSectionView => ({
  name: block.name,
  markdown: namedBlockBody(text, block),
});

export const createReadableNoteBlocks = (content: () => string | null | undefined): KitReadableNoteBlocks => ({
  table: (name) => {
    const text = content() ?? "";
    const block = matchingBlocks(text, "table", name)[0];
    return block ? tableRows(text, block) : undefined;
  },
  tables: (name) => {
    const text = content() ?? "";
    return matchingBlocks(text, "table", name).map((block) => tableRows(text, block));
  },
  list: (name) => {
    const text = content() ?? "";
    const block = matchingBlocks(text, "list", name)[0];
    return block ? listItems(text, block) : undefined;
  },
  lists: (name) => {
    const text = content() ?? "";
    return matchingBlocks(text, "list", name).map((block) => listItems(text, block));
  },
  todo: (name) => {
    const text = content() ?? "";
    const block = matchingBlocks(text, "list", name)[0];
    return block ? todoItems(text, block) : undefined;
  },
  todos: (name) => {
    const text = content() ?? "";
    return matchingBlocks(text, "list", name)
      .map((block) => todoItems(text, block))
      .filter((view) => view.items.length > 0);
  },
  data: (name) => {
    const text = content() ?? "";
    const block = matchingBlocks(text, "data", name)[0];
    return block ? dataView(text, block) : undefined;
  },
  dataBlocks: (name) => {
    const text = content() ?? "";
    return matchingBlocks(text, "data", name).map((block) => dataView(text, block));
  },
  section: (name) => {
    const text = content() ?? "";
    const block = matchingBlocks(text, "section", name)[0];
    return block ? sectionView(text, block) : undefined;
  },
  sections: (name) => {
    const text = content() ?? "";
    return matchingBlocks(text, "section", name).map((block) => sectionView(text, block));
  },
});

const tableInsertOffset = (text: string, block: NamedBlock): number => {
  const starts = lineStartOffsets(text);
  const lines = text.split("\n");
  let insertLine = block.endLine + 1;
  const lastRow = splitRow(lines[block.endLine] ?? "");
  const firstCell = (lastRow[0] ?? "").trim().toLowerCase();
  const formulaCells = lastRow.filter((cell) => cell.trim().startsWith("=")).length;
  const looksLikeFooter =
    ["total", "sum", "average", "avg", "Σ"].includes(firstCell) || (lastRow.length > 0 && formulaCells / lastRow.length > 0.5);
  if (looksLikeFooter) insertLine = block.endLine;
  return starts[insertLine] ?? text.length;
};

const rowToCells = (headers: string[], row: RowInput, rest: unknown[]): string[] => {
  const raw = rest.length > 0 ? [row, ...rest] : Array.isArray(row) ? row : [row];
  if (rest.length === 0 && raw.length === 1 && row && typeof row === "object" && !Array.isArray(row) && !isKitNote(row)) {
    const obj = row as Record<string, unknown>;
    return headers.map((header) => escapeTableCell(normalizeMarkdownValue(obj[header], header)));
  }
  return headers.map((header, index) => escapeTableCell(normalizeMarkdownValue(raw[index], header)));
};

const insertMany = (ctx: KitContext, inserts: { offset: number; text: string }[]) => {
  const ytext = requireYText(ctx);
  ytext.doc?.transact(() => {
    for (const insert of [...inserts].sort((a, b) => b.offset - a.offset)) {
      ytext.insert(insert.offset, insert.text);
    }
  });
};

const markdownAppendSeparator = (text: string, offset: number): string => {
  const before = text.slice(0, offset);
  if (before.endsWith("\n\n")) return "";
  if (before.endsWith("\n")) return "\n";
  return "\n\n";
};

const blockByNameIndex = (text: string, name: string, type: NamedBlockType, index: number): NamedBlock => {
  const block = matchingBlocks(text, type, name)[index];
  if (!block) throw new Error(`current.${type}("${name}"): named block not found`);
  return block;
};

const blockNameIndexes = (blocks: NamedBlock[]): Array<{ block: NamedBlock; index: number }> => {
  const seen = new Map<string, number>();
  return blocks.map((block) => {
    const index = seen.get(block.name) ?? 0;
    seen.set(block.name, index + 1);
    return { block, index };
  });
};

const addTableRowAt = async (ctx: KitContext, name: string, index: number, cellsInput: unknown[]) => {
  const text = currentContent(ctx);
  const block = blockByNameIndex(text, name, "table", index);
  const headers = splitRow(lineAt(text, block.startLine));
  const [row, ...rest] = cellsInput as [RowInput, ...unknown[]];
  const cells = rowToCells(headers, row, rest);
  insertMany(ctx, [{ offset: tableInsertOffset(text, block), text: `| ${cells.join(" | ")} |\n` }]);
};

const addListItemsAt = async (ctx: KitContext, name: string, index: number, items: unknown[], checkbox: boolean) => {
  const text = currentContent(ctx);
  const block = blockByNameIndex(text, name, "list", index);
  const offset = block.blockEnd;
  const prefix = text[offset] === "\n" || offset >= text.length ? "" : "\n";
  const marker = checkbox ? "- [ ] " : "- ";
  const body = items.map((item) => `${marker}${normalizeMarkdownValue(item)}`).join("\n");
  insertMany(ctx, [{ offset, text: `${prefix}\n${body}` }]);
};

const setDataAt = async (ctx: KitContext, name: string, index: number, value: Record<string, unknown>) => {
  const text = currentContent(ctx);
  const block = blockByNameIndex(text, name, "data", index);
  const ytext = requireYText(ctx);
  const next = stringifyDataBlock(value).trimEnd();
  const range = dataContentRange(text, block);
  ytext.doc?.transact(() => {
    ytext.delete(range.from, range.to - range.from);
    ytext.insert(range.from, `${next}\n`);
  });
};

const appendSectionAt = async (ctx: KitContext, name: string, index: number, markdown: string) => {
  const text = currentContent(ctx);
  const block = blockByNameIndex(text, name, "section", index);
  insertMany(ctx, [{ offset: block.blockEnd, text: `${markdownAppendSeparator(text, block.blockEnd)}${markdown}` }]);
};

export const createWritableNoteBlocks = (ctx: KitContext): KitWritableNoteBlocks => {
  const readable = createReadableNoteBlocks(() => currentContent(ctx));
  const text = () => currentContent(ctx);
  return {
    table: (name) => {
      const view = readable.table(name);
      return view ? { ...view, add: (...cells) => addTableRowAt(ctx, name, 0, cells) } : undefined;
    },
    tables: (name) =>
      blockNameIndexes(matchingBlocks(text(), "table", name)).map(({ block, index }) => ({
        ...tableRows(text(), block),
        add: (...cells) => addTableRowAt(ctx, block.name, index, cells),
      })),
    list: (name) => {
      const view = readable.list(name);
      return view ? { ...view, add: (...items) => addListItemsAt(ctx, name, 0, items, false) } : undefined;
    },
    lists: (name) =>
      blockNameIndexes(matchingBlocks(text(), "list", name)).map(({ block, index }) => ({
        ...listItems(text(), block),
        add: (...items) => addListItemsAt(ctx, block.name, index, items, false),
      })),
    todo: (name) => {
      const view = readable.todo(name);
      return view ? { ...view, add: (...items) => addListItemsAt(ctx, name, 0, items, true) } : undefined;
    },
    todos: (name) =>
      blockNameIndexes(matchingBlocks(text(), "list", name))
        .map(({ block, index }) => ({ view: todoItems(text(), block), index }))
        .filter(({ view }) => view.items.length > 0)
        .map(({ view, index }) => ({
          ...view,
          add: (...items) => addListItemsAt(ctx, view.name, index, items, true),
        })),
    data: (name) => {
      const view = readable.data(name);
      return view ? { ...view, set: (value) => setDataAt(ctx, name, 0, value) } : undefined;
    },
    dataBlocks: (name) =>
      blockNameIndexes(matchingBlocks(text(), "data", name)).map(({ block, index }) => ({
        ...dataView(text(), block),
        set: (value) => setDataAt(ctx, block.name, index, value),
      })),
    section: (name) => {
      const view = readable.section(name);
      return view ? { ...view, append: (markdown) => appendSectionAt(ctx, name, 0, markdown) } : undefined;
    },
    sections: (name) =>
      blockNameIndexes(matchingBlocks(text(), "section", name)).map(({ block, index }) => ({
        ...sectionView(text(), block),
        append: (markdown) => appendSectionAt(ctx, block.name, index, markdown),
      })),
  };
};

const dataContentRange = (text: string, block: NamedBlock): { from: number; to: number } => {
  const starts = lineStartOffsets(text);
  const from = starts[block.startLine + 1] ?? block.blockEnd;
  const to = starts[block.endLine] ?? block.blockEnd;
  return { from, to };
};
