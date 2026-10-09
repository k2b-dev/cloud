import { createHash } from "node:crypto";
import { sql } from "bun";
import { MAX_AVATAR_BYTES, MAX_AVATAR_DATA_URL_LENGTH } from "../../contracts/profile";
import type { MutationResult } from "../../contracts/shared";
import { stripImageMetadata } from "../image-metadata";

export { MAX_AVATAR_BYTES, MAX_AVATAR_DATA_URL_LENGTH } from "../../contracts/profile";

const AVATAR_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

export type ParsedAvatarDataUrl = {
  dataUrl: string;
  hash: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  bytes: Buffer;
};

export type StoredAvatar = ParsedAvatarDataUrl;

const hashAvatar = (dataUrl: string): string => createHash("sha256").update(dataUrl).digest("hex");

const isValidBase64 = (input: string, bytes: Buffer): boolean =>
  bytes.length > 0 && bytes.toString("base64").replace(/=+$/, "") === input.replace(/=+$/, "");

const hasExpectedMagicBytes = (contentType: ParsedAvatarDataUrl["contentType"], bytes: Buffer): boolean => {
  if (contentType === "image/png") {
    return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  }
  if (contentType === "image/jpeg") {
    return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
};

export const parseAvatarDataUrl = (input: string): MutationResult<ParsedAvatarDataUrl> => {
  const dataUrl = input.trim();
  if (dataUrl.length > MAX_AVATAR_DATA_URL_LENGTH) {
    return { ok: false, error: "Avatar image is too large.", status: 400 };
  }

  const match = dataUrl.match(AVATAR_DATA_URL_RE);
  if (!match) {
    return { ok: false, error: "Avatar must be a PNG, JPEG, or WebP data URL.", status: 400 };
  }

  const contentType = `image/${match[1]}` as ParsedAvatarDataUrl["contentType"];
  const base64 = match[2]!;
  const bytes = Buffer.from(base64, "base64");

  if (!isValidBase64(base64, bytes)) {
    return { ok: false, error: "Avatar data is not valid base64.", status: 400 };
  }
  if (bytes.length > MAX_AVATAR_BYTES) {
    return { ok: false, error: "Avatar image is too large.", status: 400 };
  }
  if (!hasExpectedMagicBytes(contentType, bytes)) {
    return { ok: false, error: "Avatar image content does not match its declared type.", status: 400 };
  }

  return {
    ok: true,
    data: {
      dataUrl,
      hash: hashAvatar(dataUrl),
      contentType,
      bytes,
    },
  };
};

export const getAvatar = async (params: { id: string }): Promise<StoredAvatar | null> => {
  const [row] = await sql<{ avatar_data_url: string | null; avatar_hash: string | null }[]>`
    SELECT avatar_data_url, avatar_hash
    FROM auth.users
    WHERE id = ${params.id}::uuid
  `;
  if (!row?.avatar_data_url || !row.avatar_hash) return null;

  const parsed = parseAvatarDataUrl(row.avatar_data_url);
  if (!parsed.ok) return null;
  if (parsed.data.hash !== row.avatar_hash) return null;
  return parsed.data;
};

export const setAvatar = async (params: { id: string; dataUrl: string }): Promise<MutationResult<{ avatarHash: string }>> => {
  const parsed = parseAvatarDataUrl(params.dataUrl);
  if (!parsed.ok) return parsed;

  const bytes = Buffer.from(stripImageMetadata(parsed.data.bytes));
  const dataUrl = `data:${parsed.data.contentType};base64,${bytes.toString("base64")}`;
  const rows = await sql<{ avatar_hash: string }[]>`
    UPDATE auth.users
    SET avatar_data_url = ${dataUrl},
        avatar_hash = ${hashAvatar(dataUrl)}
    WHERE id = ${params.id}::uuid
    RETURNING avatar_hash
  `;
  const avatarHash = rows[0]?.avatar_hash;
  if (!avatarHash) return { ok: false, error: "User not found", status: 404 };
  return { ok: true, data: { avatarHash } };
};

export const clearAvatar = async (params: { id: string }): Promise<MutationResult<void>> => {
  const rows = await sql<{ id: string }[]>`
    UPDATE auth.users
    SET avatar_data_url = NULL,
        avatar_hash = NULL
    WHERE id = ${params.id}::uuid
    RETURNING id
  `;
  if (!rows[0]) return { ok: false, error: "User not found", status: 404 };
  return { ok: true, data: undefined };
};
