import { type SQL, sql } from "bun";
import { AiFileVersionConflict, AiFileWriteError, aiFileContentVersion } from "./file-content-version";

export { guessAiMediaType } from "./file-media-type";

/** Per-file and per-conversation caps — read once per operation from settings by the caller layer if needed. */
export const AI_FILES_MAX_FILE_BYTES_DEFAULT = 50 * 1024 * 1024;
export const AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT = 250 * 1024 * 1024;

export type AiFileStat = {
  path: string;
  size: number;
  mediaType: string;
  origin: "user" | "assistant";
  /** Present only for recordings made through prompt dictation. */
  dictationRecordedAt?: string;
  updatedAt: string;
  version: number;
};

type FileRow = {
  path: string;
  size: number;
  media_type: string;
  origin: "user" | "assistant";
  dictation_recorded_at?: Date | string | null;
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
  ...(row.dictation_recorded_at ? { dictationRecordedAt: iso(row.dictation_recorded_at) } : {}),
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

export const createUniqueAiFileInTransaction = async (
  tx: SQL,
  input: {
    conversationId: string;
    path: string;
    bytes: Uint8Array;
    mediaType?: string;
    origin: "user" | "assistant";
    dictationRecordedAt?: string;
    maxFileBytes?: number;
    maxConversationBytes?: number;
  },
): Promise<AiFileStat> => {
  const maxFile = input.maxFileBytes ?? AI_FILES_MAX_FILE_BYTES_DEFAULT;
  const maxConversation = input.maxConversationBytes ?? AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT;
  if (input.bytes.byteLength > maxFile) {
    throw new AiFileWriteError("STORAGE_FULL", `File exceeds the per-file limit of ${Math.floor(maxFile / (1024 * 1024))} MB.`);
  }

  await tx`SELECT id FROM ai.conversations WHERE id = ${input.conversationId} FOR UPDATE`;
  const total = await aiConversationStoredBytes(tx, input.conversationId);
  if (total + input.bytes.byteLength > maxConversation) {
    throw new AiFileWriteError("STORAGE_FULL", `Conversation storage limit of ${Math.floor(maxConversation / (1024 * 1024))} MB exceeded.`);
  }

  for (let number = 1; number <= 100; number++) {
    const path = numberedAiFilePath(input.path, number);
    const rows = await tx<FileRow[]>`
        INSERT INTO ai.files (conversation_id, path, bytes, media_type, size, origin, dictation_recorded_at, updated_at)
        VALUES (${input.conversationId}, ${path}, ${input.bytes}, ${input.mediaType ?? "application/octet-stream"}, ${input.bytes.byteLength}, ${input.origin}, ${input.dictationRecordedAt ?? null}, now())
        ON CONFLICT (conversation_id, path) DO NOTHING
        RETURNING path, size, media_type, origin, dictation_recorded_at, updated_at, version
      `;
    if (rows[0]) return toStat(rows[0]);
  }
  throw new Error("Could not allocate a unique file path.");
};

const createUniqueAiFile = (input: Parameters<typeof createUniqueAiFileInTransaction>[1]) =>
  sql.begin((tx) => createUniqueAiFileInTransaction(tx, input));

/** Every file mutation holds the conversation row lock before checking this shared quota. */
export const aiConversationStoredBytes = async (db: SQL, conversationId: string, excludingPath: string | null = null): Promise<number> => {
  const [row] = await db<{ total: number | string }[]>`
    SELECT (SELECT COALESCE(SUM(size), 0) FROM ai.files
      WHERE conversation_id = ${conversationId} AND (${excludingPath}::text IS NULL OR path <> ${excludingPath}))
      + (SELECT COALESCE(SUM(octet_length(source_bytes)), 0) FROM ai.dictations WHERE conversation_id = ${conversationId}) AS total
  `;
  return Number(row?.total ?? 0);
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

/**
 * Conversation-scoped file storage backing Assistant file tools. Every
 * operation goes straight to Postgres — no rehydration, horizontal-safe,
 * crash-safe. Reads support byte slices (bytea STORAGE EXTERNAL) so big
 * files never load fully.
 */
export const aiFileStore = {
  /** Stable output for one tool call; retries cannot overwrite an edited or foreign file. */
  async createToolArtifact(input: {
    conversationId: string;
    path: string;
    bytes: Uint8Array;
    producerCallKey: string;
    mediaType: string;
  }): Promise<AiFileStat> {
    if (input.bytes.byteLength > AI_FILES_MAX_FILE_BYTES_DEFAULT)
      throw new AiFileWriteError("STORAGE_FULL", "File exceeds the destination file limit; nothing was written.");
    if (!normalizeAiFilePath(input.path)) {
      throw new Error("Invalid tool artifact path or file size.");
    }
    return sql.begin(async (tx) => {
      await tx`SELECT id FROM ai.conversations WHERE id = ${input.conversationId} FOR UPDATE`;
      const existing = await tx<(FileContentRow & { producer_call_key: string | null })[]>`
        SELECT path, bytes, size, media_type, origin, dictation_recorded_at, updated_at, version, producer_call_key
        FROM ai.files WHERE conversation_id = ${input.conversationId} AND path = ${input.path}
      `;
      const row = existing[0];
      if (row) {
        if (
          row.origin === "assistant" &&
          Number(row.version) === 1 &&
          row.producer_call_key === input.producerCallKey &&
          row.media_type === input.mediaType &&
          Buffer.from(row.bytes).equals(Buffer.from(input.bytes))
        )
          return toStat(row);
        throw new AiFileWriteError("CONFLICT", "Destination file already exists. Choose another path; nothing was written.");
      }
      const total = await aiConversationStoredBytes(tx, input.conversationId);
      if (total + input.bytes.byteLength > AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT) {
        throw new AiFileWriteError("STORAGE_FULL", "Conversation storage limit exceeded.");
      }
      const rows = await tx<FileRow[]>`
        INSERT INTO ai.files (conversation_id, path, bytes, media_type, size, origin, producer_call_key)
        VALUES (${input.conversationId}, ${input.path}, ${input.bytes}, ${input.mediaType}, ${input.bytes.byteLength}, 'assistant', ${input.producerCallKey})
        RETURNING path, size, media_type, origin, dictation_recorded_at, updated_at, version
      `;
      return toStat(rows[0]!);
    });
  },
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

  async list(input: { conversationId: string; prefix?: string; after?: string; limit?: number }): Promise<AiFileStat[]> {
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000))
      throw new Error("Invalid file page limit");
    const prefix = input.prefix ?? "/";
    const pattern = `${prefix.endsWith("/") ? prefix : `${prefix}/`}%`;
    const rows = await sql<FileRow[]>`
      SELECT path, size, media_type, origin, dictation_recorded_at, updated_at, version
      FROM ai.files
      WHERE conversation_id = ${input.conversationId}
        AND (path LIKE ${pattern} OR path = ${prefix}) AND path > ${input.after ?? ""}
      ORDER BY CASE WHEN ${input.limit === undefined} THEN updated_at END DESC, path ASC LIMIT ${input.limit ?? null}
    `;
    return rows.map(toStat);
  },

  async stat(input: { conversationId: string; path: string }): Promise<AiFileStat | null> {
    const rows = await sql<FileRow[]>`
      SELECT path, size, media_type, origin, dictation_recorded_at, updated_at, version
      FROM ai.files
      WHERE conversation_id = ${input.conversationId} AND path = ${input.path}
    `;
    return rows[0] ? toStat(rows[0]) : null;
  },

  async read(input: { conversationId: string; path: string }): Promise<AiFileContent | null> {
    const rows = await sql<FileContentRow[]>`
      SELECT path, bytes, size, media_type, origin, dictation_recorded_at, updated_at, version
      FROM ai.files
      WHERE conversation_id = ${input.conversationId} AND path = ${input.path}
    `;
    return rows[0] ? toContent(rows[0]) : null;
  },

  async readTurnFile(input: { turnId: string; path: string }): Promise<AiFileContent | null> {
    const rows = await sql<FileContentRow[]>`
      SELECT path, bytes, size, media_type, origin, dictation_recorded_at, updated_at, version
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
      SELECT path, substring(bytes FROM ${offset + 1} FOR ${length}) AS bytes, size, media_type, origin, dictation_recorded_at, updated_at, version
      FROM ai.files
      WHERE conversation_id = ${input.conversationId} AND path = ${input.path}
    `;
    return rows[0] ? toContent(rows[0]) : null;
  },

  async readTurnSliceWithStat(input: { turnId: string; path: string; offset: number; length: number }): Promise<AiFileContent | null> {
    const offset = Math.max(0, Math.floor(input.offset));
    const length = Math.max(0, Math.floor(input.length));
    const rows = await sql<FileContentRow[]>`
      SELECT path, substring(bytes FROM ${offset + 1} FOR ${length}) AS bytes, size, media_type, origin, dictation_recorded_at, updated_at, version
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
    expectedVersion?: string | null;
    ownerUserId?: string;
    maxFileBytes?: number;
    maxConversationBytes?: number;
  }): Promise<AiFileStat> {
    const maxFile = input.maxFileBytes ?? AI_FILES_MAX_FILE_BYTES_DEFAULT;
    const maxConversation = input.maxConversationBytes ?? AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT;
    if (input.bytes.byteLength > maxFile) {
      throw new AiFileWriteError("STORAGE_FULL", `File exceeds the per-file limit of ${Math.floor(maxFile / (1024 * 1024))} MB.`);
    }

    return sql.begin(async (tx) => {
      const [conversation] = await tx<
        { id: string; created_by_user_id: string; archived_at: Date | null }[]
      >`SELECT id,created_by_user_id,archived_at FROM ai.conversations WHERE id = ${input.conversationId} FOR UPDATE`;
      if (
        input.ownerUserId !== undefined &&
        (!conversation || conversation.created_by_user_id !== input.ownerUserId || conversation.archived_at)
      )
        throw new Error("Conversation access denied");
      if (input.expectedVersion !== undefined) {
        const [existing] = await tx<
          FileContentRow[]
        >`SELECT path,size,media_type,origin,updated_at,version,bytes FROM ai.files WHERE conversation_id=${input.conversationId} AND path=${input.path}`;
        const version = existing
          ? aiFileContentVersion({ ...toContent(existing), id: `${input.conversationId}:${input.path}:${existing.version}` })
          : null;
        if (version !== input.expectedVersion) throw new AiFileVersionConflict();
      }
      const otherBytes = await aiConversationStoredBytes(tx, input.conversationId, input.path);
      if (otherBytes + input.bytes.byteLength > maxConversation) {
        throw new AiFileWriteError(
          "STORAGE_FULL",
          `Conversation storage limit of ${Math.floor(maxConversation / (1024 * 1024))} MB exceeded.`,
        );
      }
      if (input.origin === "user") {
        if (input.allowUserOverwrite) {
          const written = await tx<{ id: string }[]>`
            UPDATE ai.files
            SET dictation_recorded_at = NULL, bytes = ${input.bytes}, media_type = ${input.mediaType ?? "application/octet-stream"}, size = ${input.bytes.byteLength}, updated_at = now(), version = version + 1
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
      const [written] = await tx<
        FileRow[]
      >`SELECT path,size,media_type,origin,dictation_recorded_at,updated_at,version FROM ai.files WHERE conversation_id=${input.conversationId} AND path=${input.path}`;
      return toStat(written!);
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
        throw new AiFileWriteError("STORAGE_FULL", `File exceeds the per-file limit of ${Math.floor(maxFile / (1024 * 1024))} MB.`);
      }
      const total = await aiConversationStoredBytes(tx, input.conversationId);
      if (total + input.bytes.byteLength > maxConversation) {
        throw new AiFileWriteError(
          "STORAGE_FULL",
          `Conversation storage limit of ${Math.floor(maxConversation / (1024 * 1024))} MB exceeded.`,
        );
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
    return sql.begin(async (tx) => {
      // Lock in stable order to avoid deadlocks when two chats are forked concurrently.
      await tx`SELECT id FROM ai.conversations WHERE id IN (${input.sourceConversationId}, ${input.targetConversationId}) ORDER BY id FOR UPDATE`;
      const [incoming] = await tx<{ total: number | string }[]>`
        SELECT COALESCE(SUM(source.size), 0) AS total FROM ai.files source
        WHERE source.conversation_id = ${input.sourceConversationId} AND NOT EXISTS (
          SELECT 1 FROM ai.files target WHERE target.conversation_id = ${input.targetConversationId} AND target.path = source.path
        )
      `;
      if (
        (await aiConversationStoredBytes(tx, input.targetConversationId)) + Number(incoming?.total ?? 0) >
        AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT
      ) {
        throw new AiFileWriteError("STORAGE_FULL", "Conversation storage limit exceeded.");
      }
      const rows = await tx<{ id: string }[]>`
        INSERT INTO ai.files (conversation_id, path, bytes, media_type, size, origin, dictation_recorded_at)
        SELECT ${input.targetConversationId}, path, bytes, media_type, size, origin, dictation_recorded_at
        FROM ai.files WHERE conversation_id = ${input.sourceConversationId}
        ON CONFLICT (conversation_id, path) DO NOTHING RETURNING id
      `;
      return rows.length;
    });
  },

  async totalBytes(conversationId: string): Promise<number> {
    return aiConversationStoredBytes(sql, conversationId);
  },
};

/** Authorized services may expose this read after resolving the conversation owner. */
export const listAiConversationFiles = (
  conversationId: string,
  prefix?: string,
  page?: { after?: string; limit: number },
): Promise<AiFileStat[]> => aiFileStore.list({ conversationId, prefix, ...page });

/** Authorized byte-preserving read for app-owned artifact importers. */
export async function readAiConversationFile(input: {
  conversationId: string;
  ownerUserId: string;
  path: string;
  version?: number;
}): Promise<AiFileContent | null> {
  const { aiConversations } = await import("./store");
  const conversation = await aiConversations.getConversation({ conversationId: input.conversationId, ownerUserId: input.ownerUserId });
  if (!conversation || conversation.archivedAt) return null;
  const file = await aiFileStore.read(input);
  return input.version === undefined || file?.version === input.version ? file : null;
}

/** Save one agent-produced file without overwriting an existing or user-edited file. */
export async function createAiConversationArtifact(input: {
  conversationId: string;
  ownerUserId: string;
  path: string;
  bytes: Uint8Array;
  mediaType: string;
  producerCallKey: string;
}): Promise<AiFileStat> {
  const { aiConversations } = await import("./store");
  const conversation = await aiConversations.getConversation({ conversationId: input.conversationId, ownerUserId: input.ownerUserId });
  if (!conversation || conversation.archivedAt) throw new Error("Conversation access denied");
  return aiFileStore.createToolArtifact(input);
}

/** Explicit, revision-checked file replacement for authorized transfer services. */
export async function writeAiConversationFile(input: {
  conversationId: string;
  ownerUserId: string;
  path: string;
  bytes: Uint8Array;
  mediaType: string;
  expectedVersion: string | null;
}): Promise<AiFileStat> {
  if (normalizeAiFilePath(input.path) !== input.path) throw new Error("Invalid file path");
  const current = await aiFileStore.stat(input);
  return aiFileStore.write({ ...input, origin: current?.origin ?? "assistant", allowUserOverwrite: current?.origin === "user" });
}
