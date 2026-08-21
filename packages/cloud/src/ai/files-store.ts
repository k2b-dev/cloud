import { sql } from "bun";

/** Per-file and per-conversation caps — read once per operation from settings by the caller layer if needed. */
export const AI_FILES_MAX_FILE_BYTES_DEFAULT = 50 * 1024 * 1024;
export const AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT = 250 * 1024 * 1024;

export type AiFileStat = {
  path: string;
  size: number;
  mediaType: string;
  origin: "user" | "assistant";
  updatedAt: string;
  version: number;
};

type FileRow = {
  path: string;
  size: number;
  media_type: string;
  origin: "user" | "assistant";
  updated_at: Date | string;
  version: number | string;
};

type FileContentRow = FileRow & { bytes: Uint8Array };
export type AiFileContent = AiFileStat & { bytes: Uint8Array };

const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

const toStat = (row: FileRow): AiFileStat => ({
  path: row.path,
  size: Number(row.size),
  mediaType: row.media_type,
  origin: row.origin,
  updatedAt: iso(row.updated_at),
  version: Number(row.version),
});
const toContent = (row: FileContentRow): AiFileContent => ({ ...toStat(row), bytes: row.bytes });

const numberedAiFilePath = (path: string, number: number): string => {
  if (number === 1) return path;
  const slash = path.lastIndexOf("/");
  const directory = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${directory}${name.slice(0, dot)}-${number}${name.slice(dot)}` : `${directory}${name}-${number}`;
};

const createUniqueAiFile = async (input: {
  conversationId: string;
  path: string;
  bytes: Uint8Array;
  mediaType?: string;
  origin: "user" | "assistant";
  maxFileBytes?: number;
  maxConversationBytes?: number;
}): Promise<AiFileStat> => {
  const maxFile = input.maxFileBytes ?? AI_FILES_MAX_FILE_BYTES_DEFAULT;
  const maxConversation = input.maxConversationBytes ?? AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT;
  if (input.bytes.byteLength > maxFile) {
    throw new Error(`File exceeds the per-file limit of ${Math.floor(maxFile / (1024 * 1024))} MB.`);
  }

  return sql.begin(async (tx) => {
    await tx`SELECT id FROM ai.conversations WHERE id = ${input.conversationId} FOR UPDATE`;
    const totals = await tx<{ total: number | string }[]>`
      SELECT COALESCE(SUM(size), 0) AS total FROM ai.files WHERE conversation_id = ${input.conversationId}
    `;
    if (Number(totals[0]?.total ?? 0) + input.bytes.byteLength > maxConversation) {
      throw new Error(`Conversation storage limit of ${Math.floor(maxConversation / (1024 * 1024))} MB exceeded.`);
    }

    for (let number = 1; number <= 100; number++) {
      const path = numberedAiFilePath(input.path, number);
      const rows = await tx<FileRow[]>`
        INSERT INTO ai.files (conversation_id, path, bytes, media_type, size, origin, updated_at)
        VALUES (${input.conversationId}, ${path}, ${input.bytes}, ${input.mediaType ?? "application/octet-stream"}, ${input.bytes.byteLength}, ${input.origin}, now())
        ON CONFLICT (conversation_id, path) DO NOTHING
        RETURNING path, size, media_type, origin, updated_at, version
      `;
      if (rows[0]) return toStat(rows[0]);
    }
    throw new Error("Could not allocate a unique file path.");
  });
};

/** Normalize a VFS path: absolute, no `.`/`..` segments, no trailing slash. */
export const normalizeAiFilePath = (path: string): string | null => {
  if (!path.startsWith("/")) return null;
  const segments: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    if (part.includes("\0")) return null;
    if (/[\r\n"<>]/u.test(part)) return null;
    segments.push(part);
  }
  if (segments.length === 0) return null;
  return `/${segments.join("/")}`;
};

export const decodeAiFileContent = (content: string, encoding: "utf8" | "base64"): Uint8Array => {
  if (encoding === "utf8") return new TextEncoder().encode(content);
  if (content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) throw new Error("Invalid base64 file content.");
  const bytes = Buffer.from(content, "base64");
  if (bytes.toString("base64") !== content) throw new Error("Invalid base64 file content.");
  return new Uint8Array(bytes);
};

const MEDIA_TYPES: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  xml: "application/xml",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  ts: "text/typescript",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  zip: "application/zip",
  ics: "text/calendar",
};

export const guessAiMediaType = (path: string): string => {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MEDIA_TYPES[ext] ?? "application/octet-stream";
};

/**
 * Conversation-scoped file storage backing Assistant file tools. Every
 * operation goes straight to Postgres — no rehydration, horizontal-safe,
 * crash-safe. Reads support byte slices (bytea STORAGE EXTERNAL) so big
 * files never load fully.
 */
export const aiFileStore = {
  async createUserUpload(input: {
    conversationId: string;
    path: string;
    bytes: Uint8Array;
    mediaType?: string;
    maxFileBytes?: number;
    maxConversationBytes?: number;
  }): Promise<AiFileStat> {
    return createUniqueAiFile({ ...input, origin: "user" });
  },

  async createAssistantFile(input: {
    conversationId: string;
    path: string;
    bytes: Uint8Array;
    mediaType?: string;
    maxFileBytes?: number;
    maxConversationBytes?: number;
  }): Promise<AiFileStat> {
    return createUniqueAiFile({ ...input, origin: "assistant" });
  },

  async list(input: { conversationId: string; prefix?: string }): Promise<AiFileStat[]> {
    const prefix = input.prefix ?? "/";
    const pattern = `${prefix.endsWith("/") ? prefix : `${prefix}/`}%`;
    const rows = await sql<FileRow[]>`
      SELECT path, size, media_type, origin, updated_at, version
      FROM ai.files
      WHERE conversation_id = ${input.conversationId}
        AND (path LIKE ${pattern} OR path = ${prefix})
      ORDER BY updated_at DESC, path ASC
    `;
    return rows.map(toStat);
  },

  async stat(input: { conversationId: string; path: string }): Promise<AiFileStat | null> {
    const rows = await sql<FileRow[]>`
      SELECT path, size, media_type, origin, updated_at, version
      FROM ai.files
      WHERE conversation_id = ${input.conversationId} AND path = ${input.path}
    `;
    return rows[0] ? toStat(rows[0]) : null;
  },

  async read(input: { conversationId: string; path: string }): Promise<AiFileContent | null> {
    const rows = await sql<FileContentRow[]>`
      SELECT path, bytes, size, media_type, origin, updated_at, version
      FROM ai.files
      WHERE conversation_id = ${input.conversationId} AND path = ${input.path}
    `;
    return rows[0] ? toContent(rows[0]) : null;
  },

  async readTurnFile(input: { turnId: string; path: string }): Promise<AiFileContent | null> {
    const rows = await sql<FileContentRow[]>`
      SELECT path, bytes, size, media_type, origin, updated_at, version
      FROM ai.turn_files
      WHERE turn_id = ${input.turnId}::uuid AND path = ${input.path}
    `;
    return rows[0] ? toContent(rows[0]) : null;
  },

  /** Byte slice without loading the whole value (substring on EXTERNAL bytea reads only needed chunks). */
  async readSlice(input: { conversationId: string; path: string; offset: number; length: number }): Promise<Uint8Array | null> {
    const offset = Math.max(0, Math.floor(input.offset));
    const length = Math.max(0, Math.floor(input.length));
    const rows = await sql<{ chunk: Uint8Array }[]>`
      SELECT substring(bytes FROM ${offset + 1} FOR ${length}) AS chunk
      FROM ai.files
      WHERE conversation_id = ${input.conversationId} AND path = ${input.path}
    `;
    if (!rows[0]) return null;
    return new Uint8Array(rows[0].chunk ?? []);
  },

  async readSliceWithStat(input: { conversationId: string; path: string; offset: number; length: number }): Promise<AiFileContent | null> {
    const offset = Math.max(0, Math.floor(input.offset));
    const length = Math.max(0, Math.floor(input.length));
    const rows = await sql<FileContentRow[]>`
      SELECT path, substring(bytes FROM ${offset + 1} FOR ${length}) AS bytes, size, media_type, origin, updated_at, version
      FROM ai.files
      WHERE conversation_id = ${input.conversationId} AND path = ${input.path}
    `;
    return rows[0] ? toContent(rows[0]) : null;
  },

  async readTurnSliceWithStat(input: { turnId: string; path: string; offset: number; length: number }): Promise<AiFileContent | null> {
    const offset = Math.max(0, Math.floor(input.offset));
    const length = Math.max(0, Math.floor(input.length));
    const rows = await sql<FileContentRow[]>`
      SELECT path, substring(bytes FROM ${offset + 1} FOR ${length}) AS bytes, size, media_type, origin, updated_at, version
      FROM ai.turn_files
      WHERE turn_id = ${input.turnId}::uuid AND path = ${input.path}
    `;
    return rows[0] ? toContent(rows[0]) : null;
  },

  async readAll(input: { conversationId: string; path: string }): Promise<Uint8Array | null> {
    const rows = await sql<{ bytes: Uint8Array }[]>`
      SELECT bytes FROM ai.files
      WHERE conversation_id = ${input.conversationId} AND path = ${input.path}
    `;
    if (!rows[0]) return null;
    return new Uint8Array(rows[0].bytes ?? []);
  },

  /**
   * Upsert one file. Enforces the per-file and per-conversation caps —
   * here in the store so no command or tool can bypass them.
   */
  async write(input: {
    conversationId: string;
    path: string;
    bytes: Uint8Array;
    mediaType?: string;
    origin?: "user" | "assistant";
    allowUserOverwrite?: boolean;
    maxFileBytes?: number;
    maxConversationBytes?: number;
  }): Promise<void> {
    const maxFile = input.maxFileBytes ?? AI_FILES_MAX_FILE_BYTES_DEFAULT;
    const maxConversation = input.maxConversationBytes ?? AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT;
    if (input.bytes.byteLength > maxFile) {
      throw new Error(`File exceeds the per-file limit of ${Math.floor(maxFile / (1024 * 1024))} MB.`);
    }

    await sql.begin(async (tx) => {
      await tx`SELECT id FROM ai.conversations WHERE id = ${input.conversationId} FOR UPDATE`;
      const totals = await tx<{ total: number | string }[]>`
        SELECT COALESCE(SUM(size), 0) AS total
        FROM ai.files
        WHERE conversation_id = ${input.conversationId} AND path <> ${input.path}
      `;
      const otherBytes = Number(totals[0]?.total ?? 0);
      if (otherBytes + input.bytes.byteLength > maxConversation) {
        throw new Error(`Conversation storage limit of ${Math.floor(maxConversation / (1024 * 1024))} MB exceeded.`);
      }
      if (input.origin === "user") {
        if (input.allowUserOverwrite) {
          const written = await tx<{ id: string }[]>`
            UPDATE ai.files
            SET bytes = ${input.bytes}, media_type = ${input.mediaType ?? "application/octet-stream"}, size = ${input.bytes.byteLength}, updated_at = now(), version = version + 1
            WHERE conversation_id = ${input.conversationId} AND path = ${input.path} AND origin = 'user'
            RETURNING id
          `;
          if (!written[0]) throw new Error(`User-uploaded file does not exist: ${input.path}.`);
        } else {
          await tx`
            INSERT INTO ai.files (conversation_id, path, bytes, media_type, size, origin, updated_at)
            VALUES (${input.conversationId}, ${input.path}, ${input.bytes}, ${input.mediaType ?? "application/octet-stream"}, ${input.bytes.byteLength}, 'user', now())
          `;
        }
      } else {
        const written = await tx<{ id: string }[]>`
          INSERT INTO ai.files (conversation_id, path, bytes, media_type, size, origin, updated_at)
          VALUES (${input.conversationId}, ${input.path}, ${input.bytes}, ${input.mediaType ?? "application/octet-stream"}, ${input.bytes.byteLength}, 'assistant', now())
          ON CONFLICT (conversation_id, path) DO UPDATE SET
            bytes = EXCLUDED.bytes,
            media_type = EXCLUDED.media_type,
            size = EXCLUDED.size,
            updated_at = now(),
            version = ai.files.version + 1
          WHERE ai.files.origin = 'assistant'
          RETURNING id
        `;
        if (!written[0]) throw new Error(`Cannot overwrite user-uploaded file ${input.path}.`);
      }
    });
  },

  async append(input: {
    conversationId: string;
    path: string;
    bytes: Uint8Array;
    mediaType?: string;
    maxFileBytes?: number;
    maxConversationBytes?: number;
  }): Promise<void> {
    const maxFile = input.maxFileBytes ?? AI_FILES_MAX_FILE_BYTES_DEFAULT;
    const maxConversation = input.maxConversationBytes ?? AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT;
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM ai.conversations WHERE id = ${input.conversationId} FOR UPDATE`;
      const current = await tx<{ size: number }[]>`
        SELECT size FROM ai.files
        WHERE conversation_id = ${input.conversationId} AND path = ${input.path}
      `;
      const nextSize = Number(current[0]?.size ?? 0) + input.bytes.byteLength;
      if (nextSize > maxFile) {
        throw new Error(`File exceeds the per-file limit of ${Math.floor(maxFile / (1024 * 1024))} MB.`);
      }
      const totals = await tx<{ total: number | string }[]>`
        SELECT COALESCE(SUM(size), 0) AS total FROM ai.files WHERE conversation_id = ${input.conversationId}
      `;
      if (Number(totals[0]?.total ?? 0) + input.bytes.byteLength > maxConversation) {
        throw new Error(`Conversation storage limit of ${Math.floor(maxConversation / (1024 * 1024))} MB exceeded.`);
      }
      const appended = await tx<{ id: string }[]>`
        INSERT INTO ai.files (conversation_id, path, bytes, media_type, size, origin, updated_at)
        VALUES (${input.conversationId}, ${input.path}, ${input.bytes}, ${input.mediaType ?? "application/octet-stream"}, ${input.bytes.byteLength}, 'assistant', now())
        ON CONFLICT (conversation_id, path) DO UPDATE SET
          bytes = ai.files.bytes || EXCLUDED.bytes,
          size = ai.files.size + EXCLUDED.size,
          updated_at = now(),
          version = ai.files.version + 1
        WHERE ai.files.origin = 'assistant'
        RETURNING id
      `;
      if (!appended[0]) throw new Error(`Cannot append to user-uploaded file ${input.path}.`);
    });
  },

  async remove(input: { conversationId: string; path: string; recursive?: boolean }): Promise<number> {
    return sql.begin(async (tx) => {
      await tx`SELECT id FROM ai.conversations WHERE id = ${input.conversationId} FOR UPDATE`;
      if (input.recursive) {
        const pattern = `${input.path.endsWith("/") ? input.path : `${input.path}/`}%`;
        const rows = await tx<{ id: string }[]>`
          DELETE FROM ai.files
          WHERE conversation_id = ${input.conversationId} AND (path = ${input.path} OR path LIKE ${pattern})
          RETURNING id
        `;
        return rows.length;
      }
      const rows = await tx<{ id: string }[]>`
        DELETE FROM ai.files
        WHERE conversation_id = ${input.conversationId} AND path = ${input.path}
        RETURNING id
      `;
      return rows.length;
    });
  },

  async rename(input: { conversationId: string; from: string; to: string }): Promise<"renamed" | "not_found" | "conflict"> {
    return sql.begin(async (tx) => {
      await tx`SELECT id FROM ai.conversations WHERE id = ${input.conversationId} FOR UPDATE`;
      const source = await tx<{ id: string }[]>`
        SELECT id FROM ai.files WHERE conversation_id = ${input.conversationId} AND path = ${input.from}
      `;
      if (!source[0]) return "not_found" as const;
      const target = await tx<{ id: string }[]>`
        SELECT id FROM ai.files WHERE conversation_id = ${input.conversationId} AND path = ${input.to}
      `;
      if (target[0]) return "conflict" as const;
      await tx`UPDATE ai.files SET path = ${input.to}, updated_at = now(), version = version + 1 WHERE id = ${source[0].id}::uuid`;
      return "renamed" as const;
    });
  },

  /** Copy every file into another conversation (fork). */
  async copyToConversation(input: { sourceConversationId: string; targetConversationId: string }): Promise<number> {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO ai.files (conversation_id, path, bytes, media_type, size, origin)
      SELECT ${input.targetConversationId}, path, bytes, media_type, size, origin
      FROM ai.files
      WHERE conversation_id = ${input.sourceConversationId}
      ON CONFLICT (conversation_id, path) DO NOTHING
      RETURNING id
    `;
    return rows.length;
  },

  async totalBytes(conversationId: string): Promise<number> {
    const rows = await sql<{ total: number | string }[]>`
      SELECT COALESCE(SUM(size), 0) AS total FROM ai.files WHERE conversation_id = ${conversationId}
    `;
    return Number(rows[0]?.total ?? 0);
  },
};

/** Authorized services may expose this read after resolving the conversation owner. */
export const listAiConversationFiles = (conversationId: string, prefix?: string): Promise<AiFileStat[]> =>
  aiFileStore.list({ conversationId, prefix });
