import type { AttachmentContent } from "./attachments";
import * as attachments from "./attachments";
import type { Notebook } from "./notebooks";
import * as notebooks from "./notebooks";
import type { Note } from "./notes";
import * as notes from "./notes";

export type NotebookExportFile = {
  path: string;
  content: string | Uint8Array;
};

export type NotebookExport = {
  filename: string;
  notebook: Pick<Notebook, "name"> & { id: string };
  files: NotebookExportFile[];
  zip: Uint8Array;
};

const textEncoder = new TextEncoder();

const slugify = (value: string, fallback: string): string => {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || fallback;
};

const safeFilename = (value: string, fallback: string): string => {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\\/:"*?<>|\x00-\x1f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
};

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const yamlValue = (value: string | number | null): string => {
  if (value === null) return "null";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
};

const noteFileName = (note: Note): string => `${note.shortId}--${slugify(note.title, "untitled")}.md`;

const attachmentFileName = (attachment: AttachmentContent): string =>
  `${attachment.shortId}--${safeFilename(attachment.filename, "attachment")}`;

const publicNotebook = (notebook: Notebook) => ({
  id: notebook.shortId,
  name: notebook.name,
  description: notebook.description,
  icon: notebook.icon,
  homepageNoteId: notebook.homepageNoteShortId,
  scriptsEnabled: notebook.scriptsEnabled,
  defaultPresentationMode: notebook.defaultPresentationMode,
  defaultNoteTitleTemplate: notebook.defaultNoteTitleTemplate,
  createdBy: notebook.createdBy,
  createdAt: notebook.createdAt,
  updatedAt: notebook.updatedAt,
});

const buildTree = (flatNotes: Note[]) => {
  type Node = Pick<Note, "id" | "shortId" | "parentId" | "title" | "position" | "createdAt" | "updatedAt"> & {
    children: Node[];
  };

  const nodes = new Map<string, Node>();
  const roots: Node[] = [];

  for (const note of flatNotes) {
    nodes.set(note.id, {
      id: note.id,
      shortId: note.shortId,
      parentId: note.parentId,
      title: note.title,
      position: note.position,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      children: [],
    });
  }

  for (const note of flatNotes) {
    const node = nodes.get(note.id);
    if (!node) continue;
    const parent = note.parentId ? nodes.get(note.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sort = (items: Node[]) => {
    items.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    for (const item of items) sort(item.children);
  };
  sort(roots);

  const shortById = new Map(flatNotes.map((note) => [note.id, note.shortId]));
  const toPublicNode = (node: Node): Record<string, unknown> => ({
    id: node.shortId,
    parentId: node.parentId ? (shortById.get(node.parentId) ?? null) : null,
    title: node.title,
    position: node.position,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    children: node.children.map(toPublicNode),
  });
  return roots.map(toPublicNode);
};

const transformPortableLinks = (
  content: string,
  noteFileByShortId: Map<string, string>,
  attachmentFileByShortId: Map<string, string>,
): string =>
  content
    .replace(/note:\/\/([0-9a-zA-Z]{6})/g, (match, shortId: string) => {
      const file = noteFileByShortId.get(shortId);
      return file ? `./${file}` : match;
    })
    .replace(/attach:\/\/([0-9a-zA-Z]{6})/g, (match, shortId: string) => {
      const file = attachmentFileByShortId.get(shortId);
      return file ? `../attachments/${file}` : match;
    });

const noteFrontmatter = (note: Note, parentId: string | null): string =>
  [
    "---",
    `id: ${yamlValue(note.shortId)}`,
    `title: ${yamlValue(note.title)}`,
    `parentId: ${yamlValue(parentId)}`,
    `position: ${yamlValue(note.position)}`,
    `createdAt: ${yamlValue(note.createdAt)}`,
    `updatedAt: ${yamlValue(note.updatedAt)}`,
    `lockedAt: ${yamlValue(note.lockedAt)}`,
    "---",
    "",
  ].join("\n");

const readme = (params: { notebook: Notebook; exportedAt: string; noteCount: number; attachmentCount: number }): string =>
  [
    `# ${params.notebook.name}`,
    "",
    `Exported: ${params.exportedAt}`,
    `Notes: ${params.noteCount}`,
    `Attachments: ${params.attachmentCount}`,
    "",
    "This archive is plain Markdown plus raw attachment files.",
    "",
    "- `notes/` contains one Markdown file per note.",
    "- `attachments/` contains uploaded files.",
    "- `tree.json` keeps the notebook hierarchy.",
    "- `notebook.json` and `attachments.json` keep app metadata for future import tools.",
    "",
  ].join("\n");

export const buildNotebookExportFiles = (params: {
  notebook: Notebook;
  notes: Note[];
  attachments: AttachmentContent[];
  exportedAt?: Date;
}): NotebookExportFile[] => {
  const exportedAt = (params.exportedAt ?? new Date()).toISOString();
  const sortedNotes = [...params.notes].sort(
    (a, b) =>
      (a.parentId ?? "").localeCompare(b.parentId ?? "") ||
      a.position - b.position ||
      a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id),
  );
  const sortedAttachments = [...params.attachments].sort((a, b) => a.shortId.localeCompare(b.shortId));

  const noteFileByShortId = new Map(sortedNotes.map((note) => [note.shortId, noteFileName(note)]));
  const noteShortIdById = new Map(sortedNotes.map((note) => [note.id, note.shortId]));
  const attachmentFileByShortId = new Map(sortedAttachments.map((attachment) => [attachment.shortId, attachmentFileName(attachment)]));

  const files: NotebookExportFile[] = [
    {
      path: "README.md",
      content: readme({
        notebook: params.notebook,
        exportedAt,
        noteCount: sortedNotes.length,
        attachmentCount: sortedAttachments.length,
      }),
    },
    {
      path: "notebook.json",
      content: json({
        format: "stuve.notebook.export",
        version: 2,
        exportedAt,
        notebook: publicNotebook(params.notebook),
      }),
    },
    {
      path: "tree.json",
      content: json(buildTree(sortedNotes)),
    },
    {
      path: "attachments.json",
      content: json(
        sortedAttachments.map((attachment) => ({
          id: attachment.shortId,
          notebookId: params.notebook.shortId,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          kind: attachment.kind,
          createdBy: attachment.createdBy,
          createdAt: attachment.createdAt,
          file: `attachments/${attachmentFileName({ ...attachment, content: new Uint8Array() })}`,
        })),
      ),
    },
  ];

  for (const note of sortedNotes) {
    const body = transformPortableLinks(note.contentMd ?? "", noteFileByShortId, attachmentFileByShortId);
    files.push({
      path: `notes/${noteFileName(note)}`,
      content: `${noteFrontmatter(note, note.parentId ? (noteShortIdById.get(note.parentId) ?? null) : null)}${
        body.endsWith("\n") || body.length === 0 ? body : `${body}\n`
      }`,
    });
  }

  for (const attachment of sortedAttachments) {
    files.push({
      path: `attachments/${attachmentFileName(attachment)}`,
      content: attachment.content,
    });
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
};

let crcTable: Uint32Array | null = null;

const getCrcTable = (): Uint32Array => {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  crcTable = table;
  return table;
};

const crc32 = (bytes: Uint8Array): number => {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const toBytes = (content: string | Uint8Array): Uint8Array => (typeof content === "string" ? textEncoder.encode(content) : content);

const concat = (chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

const u16 = (value: number): Uint8Array => {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
};

const u32 = (value: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
};

const dosDateTime = (date: Date): { date: number; time: number } => ({
  date: (((date.getFullYear() - 1980) & 0x7f) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
});

export const createZip = (files: NotebookExportFile[], date = new Date()): Uint8Array => {
  const chunks: Uint8Array[] = [];
  const centralDirectory: Uint8Array[] = [];
  const { date: modifiedDate, time: modifiedTime } = dosDateTime(date);
  let offset = 0;

  for (const file of files) {
    const path = textEncoder.encode(file.path);
    const content = toBytes(file.content);
    const crc = crc32(content);
    const localHeader = concat([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(modifiedTime),
      u16(modifiedDate),
      u32(crc),
      u32(content.byteLength),
      u32(content.byteLength),
      u16(path.byteLength),
      u16(0),
      path,
    ]);

    chunks.push(localHeader, content);
    centralDirectory.push(
      concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(modifiedTime),
        u16(modifiedDate),
        u32(crc),
        u32(content.byteLength),
        u32(content.byteLength),
        u16(path.byteLength),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        path,
      ]),
    );
    offset += localHeader.byteLength + content.byteLength;
  }

  const centralOffset = offset;
  const central = concat(centralDirectory);
  const end = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(central.byteLength),
    u32(centralOffset),
    u16(0),
  ]);

  return concat([...chunks, central, end]);
};

export const exportFilename = (notebook: Notebook, exportedAt = new Date()): string => {
  const stamp = exportedAt.toISOString().slice(0, 10);
  return `${slugify(notebook.name, "notebook")}-${stamp}.zip`;
};

export const exportNotebookZip = async (params: { notebookId: string; exportedAt?: Date }): Promise<NotebookExport | null> => {
  const notebook = await notebooks.get({ id: params.notebookId });
  if (!notebook) return null;

  const [flatNotes, attachmentMetadata] = await Promise.all([
    notes.list({ notebookId: notebook.id }),
    attachments.list({ notebookId: notebook.id }),
  ]);
  const attachmentContents = (
    await Promise.all(attachmentMetadata.map((attachment) => attachments.getContent({ id: attachment.id })))
  ).filter((attachment): attachment is AttachmentContent => attachment !== null);

  const exportedAt = params.exportedAt ?? new Date();
  const files = buildNotebookExportFiles({
    notebook,
    notes: flatNotes,
    attachments: attachmentContents,
    exportedAt,
  });
  return {
    filename: exportFilename(notebook, exportedAt),
    notebook: {
      id: notebook.shortId,
      name: notebook.name,
    },
    files,
    zip: createZip(files, exportedAt),
  };
};
