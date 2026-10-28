import { createHash } from "node:crypto";
import { sql } from "bun";
import {
  type AvatarConfig,
  type AvatarKind,
  canonicalAvatarConfig,
  type PersonAvatar,
  PersonAvatarSchema,
  type RobotAvatar,
  RobotAvatarSchema,
  robotAvatarFromSeed,
} from "../../contracts/avatar";
import { MAX_AVATAR_BYTES, MAX_AVATAR_DATA_URL_LENGTH } from "../../contracts/profile";
import type { MutationResult } from "../../contracts/shared";
import { AVATAR_RENDERER_REVISION, renderAvatarSvg } from "../../shared/avatar-art";
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

/** The image others see under an account's avatar URL. */
export type ServedAvatar = {
  hash: string;
  contentType: ParsedAvatarDataUrl["contentType"] | "image/svg+xml";
  bytes: Buffer;
};

/**
 * What the profile picture dialog shows: the active kind, the built config, and the stored photo. Only the account
 * holder (or an administrator for a service account) reads this; others see only the active picture.
 */
export type AvatarState<Built extends AvatarConfig = AvatarConfig> = {
  kind: AvatarKind;
  built: Built | null;
  hasPhoto: boolean;
  photo: string | null;
  avatarHash: string | null;
};

/** One save in the dialog: store and show a photo or a built avatar, or switch to what is stored. */
export type AvatarChange<Built extends AvatarConfig = AvatarConfig> = { dataUrl: string } | { built: Built } | { use: AvatarKind };

type AvatarRow = {
  id: string;
  avatar_kind: AvatarKind | null;
  avatar_config: unknown;
  avatar_data_url: string | null;
  avatar_hash: string | null;
};

/** The hash of a built avatar; it changes with the renderer revision, so caches refetch a redrawn avatar. */
export const builtAvatarHash = (config: AvatarConfig): string =>
  createHash("sha256")
    .update(`built:${AVATAR_RENDERER_REVISION}:${canonicalAvatarConfig(config)}`)
    .digest("hex");

const svgAvatar = (config: AvatarConfig, hash: string): ServedAvatar => ({
  hash,
  contentType: "image/svg+xml",
  bytes: Buffer.from(renderAvatarSvg(config)),
});

const photoAvatar = (row: AvatarRow): ServedAvatar | null => {
  if (!row.avatar_data_url || !row.avatar_hash) return null;
  const parsed = parseAvatarDataUrl(row.avatar_data_url);
  if (!parsed.ok || parsed.data.hash !== row.avatar_hash) return null;
  return parsed.data;
};

const parsePerson = (value: unknown): PersonAvatar | null => {
  const parsed = PersonAvatarSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};
const parseRobot = (value: unknown): RobotAvatar | null => {
  const parsed = RobotAvatarSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** A row from before built avatars has no kind: a stored photo is active, otherwise initials. */
const userKind = (row: AvatarRow): AvatarKind => row.avatar_kind ?? (row.avatar_data_url ? "photo" : "initials");

/**
 * A service account always shows a picture: its photo, or its robot, drawn from the account id until customised. The
 * seed is the id as stored, so every spelling of the id in a URL draws the same robot.
 */
const serviceAccountRobot = (row: AvatarRow): RobotAvatar => parseRobot(row.avatar_config) ?? robotAvatarFromSeed(row.id);

const readUserRow = async (db: typeof sql, id: string, lock = false): Promise<AvatarRow | undefined> => {
  const [row] = lock
    ? await db<AvatarRow[]>`
        SELECT id, avatar_kind, avatar_config, avatar_data_url, avatar_hash FROM auth.users WHERE id = ${id}::uuid FOR UPDATE
      `
    : await db<AvatarRow[]>`SELECT id, avatar_kind, avatar_config, avatar_data_url, avatar_hash FROM auth.users WHERE id = ${id}::uuid`;
  return row;
};

const readServiceAccountRow = async (db: typeof sql, id: string, lock = false): Promise<AvatarRow | undefined> => {
  const [row] = lock
    ? await db<AvatarRow[]>`
        SELECT id, avatar_kind, avatar_config, avatar_data_url, avatar_hash FROM auth.service_accounts WHERE id = ${id}::uuid FOR UPDATE
      `
    : await db<AvatarRow[]>`
        SELECT id, avatar_kind, avatar_config, avatar_data_url, avatar_hash FROM auth.service_accounts WHERE id = ${id}::uuid
      `;
  return row;
};

/**
 * The image others see for a person or a service account, or null when a person shows initials. An inactive photo is
 * never served.
 */
export const getAvatar = async (params: { id: string }): Promise<ServedAvatar | null> => {
  const user = await readUserRow(sql, params.id);
  if (user) {
    const kind = userKind(user);
    if (kind === "photo") return photoAvatar(user);
    if (kind === "built") {
      // The served hash comes from the renderer drawing these bytes, not from storage: while a rollout mixes renderer
      // revisions, a stored hash of another revision never marks these bytes as immutable.
      const config = parsePerson(user.avatar_config);
      return config ? svgAvatar(config, builtAvatarHash(config)) : null;
    }
    return null;
  }
  const account = await readServiceAccountRow(sql, params.id);
  if (!account) return null;
  if (account.avatar_kind === "photo") return photoAvatar(account);
  const robot = serviceAccountRobot(account);
  return svgAvatar(robot, builtAvatarHash(robot));
};

const userState = (row: AvatarRow): AvatarState<PersonAvatar> => ({
  kind: userKind(row),
  built: parsePerson(row.avatar_config),
  hasPhoto: row.avatar_data_url !== null,
  photo: row.avatar_data_url,
  avatarHash: row.avatar_hash,
});

const serviceAccountState = (row: AvatarRow): AvatarState<RobotAvatar> => {
  const robot = serviceAccountRobot(row);
  return {
    kind: row.avatar_kind === "photo" ? "photo" : "built",
    built: robot,
    hasPhoto: row.avatar_data_url !== null,
    photo: row.avatar_data_url,
    avatarHash: row.avatar_kind === "photo" ? row.avatar_hash : (row.avatar_hash ?? builtAvatarHash(robot)),
  };
};

export const getAvatarState = async (params: { id: string }): Promise<AvatarState<PersonAvatar> | null> => {
  const row = await readUserRow(sql, params.id);
  return row ? userState(row) : null;
};

export const getServiceAccountAvatarState = async (params: { id: string }): Promise<AvatarState<RobotAvatar> | null> => {
  const row = await readServiceAccountRow(sql, params.id);
  return row ? serviceAccountState(row) : null;
};

const strippedPhoto = (dataUrl: string): MutationResult<{ dataUrl: string; hash: string }> => {
  const parsed = parseAvatarDataUrl(dataUrl);
  if (!parsed.ok) return parsed;
  const bytes = Buffer.from(stripImageMetadata(parsed.data.bytes));
  const stripped = `data:${parsed.data.contentType};base64,${bytes.toString("base64")}`;
  return { ok: true, data: { dataUrl: stripped, hash: hashAvatar(stripped) } };
};

const notFound = { ok: false, error: "User not found", status: 404 } as const;
const missing = (what: string) => ({ ok: false, error: `No ${what} is stored to show.`, status: 409 }) as const;

/** A change whose photo is already stripped; stripping happens before any storage access and throws a typed 422. */
type PreparedChange = { photo: { dataUrl: string; hash: string } } | Exclude<AvatarChange, { dataUrl: string }>;

const prepareChange = (change: AvatarChange): MutationResult<PreparedChange> => {
  if (!("dataUrl" in change)) return { ok: true, data: change };
  const photo = strippedPhoto(change.dataUrl);
  return photo.ok ? { ok: true, data: { photo: photo.data } } : photo;
};

/** Applies one dialog save to a person: the new values for the avatar columns, or why the save cannot happen. */
const nextUserColumns = (row: AvatarRow, change: PreparedChange): MutationResult<AvatarRow> => {
  if ("photo" in change) {
    return { ok: true, data: { ...row, avatar_kind: "photo", avatar_data_url: change.photo.dataUrl, avatar_hash: change.photo.hash } };
  }
  if ("built" in change) {
    const config = parsePerson(change.built);
    if (!config) return { ok: false, error: "A person's avatar must use the person shape set.", status: 400 };
    return { ok: true, data: { ...row, avatar_kind: "built", avatar_config: config, avatar_hash: builtAvatarHash(config) } };
  }
  if (change.use === "photo") {
    if (!row.avatar_data_url) return missing("photo");
    return { ok: true, data: { ...row, avatar_kind: "photo", avatar_hash: hashAvatar(row.avatar_data_url) } };
  }
  if (change.use === "built") {
    const config = parsePerson(row.avatar_config);
    if (!config) return missing("avatar");
    return { ok: true, data: { ...row, avatar_kind: "built", avatar_hash: builtAvatarHash(config) } };
  }
  return { ok: true, data: { ...row, avatar_kind: "initials", avatar_hash: null } };
};

const nextServiceAccountColumns = (row: AvatarRow, change: PreparedChange): MutationResult<AvatarRow> => {
  if ("photo" in change) {
    return { ok: true, data: { ...row, avatar_kind: "photo", avatar_data_url: change.photo.dataUrl, avatar_hash: change.photo.hash } };
  }
  if ("built" in change) {
    const config = parseRobot(change.built);
    if (!config) return { ok: false, error: "A service account's avatar must use the robot shape set.", status: 400 };
    return { ok: true, data: { ...row, avatar_kind: "built", avatar_config: config, avatar_hash: builtAvatarHash(config) } };
  }
  if (change.use === "photo") {
    if (!row.avatar_data_url) return missing("photo");
    return { ok: true, data: { ...row, avatar_kind: "photo", avatar_hash: hashAvatar(row.avatar_data_url) } };
  }
  if (change.use === "built") {
    const config = parseRobot(row.avatar_config);
    return { ok: true, data: { ...row, avatar_kind: "built", avatar_hash: config ? builtAvatarHash(config) : null } };
  }
  return { ok: false, error: "A service account always shows a picture: a photo or its robot.", status: 400 };
};

const writeUserColumns = (db: typeof sql, id: string, row: AvatarRow) => db`
  UPDATE auth.users
  SET avatar_kind = ${row.avatar_kind},
      avatar_config = ${row.avatar_config === null ? null : JSON.stringify(row.avatar_config)}::text::jsonb,
      avatar_data_url = ${row.avatar_data_url},
      avatar_hash = ${row.avatar_hash}
  WHERE id = ${id}::uuid
`;

const writeServiceAccountColumns = (db: typeof sql, id: string, row: AvatarRow) => db`
  UPDATE auth.service_accounts
  SET avatar_kind = ${row.avatar_kind},
      avatar_config = ${row.avatar_config === null ? null : JSON.stringify(row.avatar_config)}::text::jsonb,
      avatar_data_url = ${row.avatar_data_url},
      avatar_hash = ${row.avatar_hash}
  WHERE id = ${id}::uuid
`;

/** Saves a person's profile picture: a photo, a built avatar, or which stored picture others see. */
export const updateAvatar = async (params: { id: string; change: AvatarChange }): Promise<MutationResult<AvatarState<PersonAvatar>>> => {
  const change = prepareChange(params.change);
  if (!change.ok) return change;
  return sql.begin(async (tx) => {
    const row = await readUserRow(tx, params.id, true);
    if (!row) return notFound;
    const next = nextUserColumns(row, change.data);
    if (!next.ok) return next;
    await writeUserColumns(tx, params.id, next.data);
    return { ok: true, data: userState(next.data) };
  });
};

/** Saves a service account's picture: a photo, a customised robot, or which of them others see. */
export const updateServiceAccountAvatar = async (params: {
  id: string;
  change: AvatarChange;
}): Promise<MutationResult<AvatarState<RobotAvatar>>> => {
  const change = prepareChange(params.change);
  if (!change.ok) return change;
  return sql.begin(async (tx) => {
    const row = await readServiceAccountRow(tx, params.id, true);
    if (!row) return { ok: false, error: "Service account not found", status: 404 };
    const next = nextServiceAccountColumns(row, change.data);
    if (!next.ok) return next;
    await writeServiceAccountColumns(tx, params.id, next.data);
    return { ok: true, data: serviceAccountState(next.data) };
  });
};

/** Stores and shows a photo. Kept for the photo-only callers; same as `updateAvatar` with `{ dataUrl }`. */
export const setAvatar = async (params: { id: string; dataUrl: string }): Promise<MutationResult<{ avatarHash: string }>> => {
  const result = await updateAvatar({ id: params.id, change: { dataUrl: params.dataUrl } });
  if (!result.ok) return result;
  return { ok: true, data: { avatarHash: result.data.avatarHash ?? "" } };
};

/** Deletes a person's photo. When the photo was showing, initials show instead; a shown built avatar stays. */
export const clearAvatar = async (params: { id: string }): Promise<MutationResult<void>> =>
  sql.begin(async (tx) => {
    const row = await readUserRow(tx, params.id, true);
    if (!row) return notFound;
    const showingPhoto = userKind(row) === "photo";
    await writeUserColumns(tx, params.id, {
      ...row,
      avatar_kind: showingPhoto ? "initials" : row.avatar_kind,
      avatar_data_url: null,
      avatar_hash: showingPhoto ? null : row.avatar_hash,
    });
    return { ok: true, data: undefined };
  });

/** Deletes a service account's photo; its robot shows again. */
export const clearServiceAccountAvatar = async (params: { id: string }): Promise<MutationResult<AvatarState<RobotAvatar>>> =>
  sql.begin(async (tx) => {
    const row = await readServiceAccountRow(tx, params.id, true);
    if (!row) return { ok: false, error: "Service account not found", status: 404 };
    const config = parseRobot(row.avatar_config);
    const next: AvatarRow = { ...row, avatar_kind: "built", avatar_data_url: null, avatar_hash: config ? builtAvatarHash(config) : null };
    await writeServiceAccountColumns(tx, params.id, next);
    return { ok: true, data: serviceAccountState(next) };
  });

const REFRESH_BATCH = 500;

type RefreshRow = { id: string; avatar_config: unknown; avatar_hash: string | null };

/**
 * Writes the current renderer's hash for one stored built avatar, only if the row still holds the config and hash
 * that were read: a save on another replica in between wins and keeps its own hash.
 */
export const writeRefreshedHash = async (db: typeof sql, table: "users" | "service_accounts", row: RefreshRow): Promise<boolean> => {
  const config = table === "users" ? parsePerson(row.avatar_config) : parseRobot(row.avatar_config);
  const hash = config ? builtAvatarHash(config) : null;
  if (!hash || hash === row.avatar_hash) return false;
  const configText = JSON.stringify(row.avatar_config);
  const written =
    table === "users"
      ? await db`
          UPDATE auth.users SET avatar_hash = ${hash}
          WHERE id = ${row.id}::uuid AND avatar_kind = 'built'
            AND avatar_config = ${configText}::text::jsonb AND avatar_hash IS NOT DISTINCT FROM ${row.avatar_hash}
        `
      : await db`
          UPDATE auth.service_accounts SET avatar_hash = ${hash}
          WHERE id = ${row.id}::uuid AND COALESCE(avatar_kind, 'built') = 'built'
            AND avatar_config = ${configText}::text::jsonb AND avatar_hash IS NOT DISTINCT FROM ${row.avatar_hash}
        `;
  return written.count > 0;
};

/**
 * Re-hashes stored built avatars after the renderer revision changed, so every client fetches the redrawn image. Runs
 * at startup in bounded batches and writes only rows whose hash differs.
 */
export const refreshBuiltAvatarHashes = async (db: typeof sql = sql): Promise<number> => {
  let updated = 0;
  for (const table of ["users", "service_accounts"] as const) {
    let after = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      const rows =
        table === "users"
          ? await db<RefreshRow[]>`
              SELECT id, avatar_config, avatar_hash FROM auth.users
              WHERE avatar_kind = 'built' AND id > ${after}::uuid ORDER BY id LIMIT ${REFRESH_BATCH}
            `
          : await db<RefreshRow[]>`
              SELECT id, avatar_config, avatar_hash FROM auth.service_accounts
              WHERE COALESCE(avatar_kind, 'built') = 'built' AND avatar_config IS NOT NULL AND id > ${after}::uuid
              ORDER BY id LIMIT ${REFRESH_BATCH}
            `;
      for (const row of rows) if (await writeRefreshedHash(db, table, row)) updated++;
      if (rows.length < REFRESH_BATCH) break;
      after = rows.at(-1)?.id ?? after;
    }
  }
  return updated;
};
