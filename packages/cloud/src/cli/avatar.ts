import { readFile } from "node:fs/promises";
import { type AvatarConfig, PersonAvatarSchema, RobotAvatarSchema } from "../contracts/avatar";
import { MAX_AVATAR_BYTES } from "../contracts/profile";

/** What `GET …/avatar` answers for a person or a service account. */
export type CliAvatarState = {
  kind: "photo" | "built" | "initials";
  built: AvatarConfig | null;
  hasPhoto: boolean;
  photo: string | null;
  avatarHash: string | null;
};

/** One row per fact: which picture shows, whether a photo is stored, then every part of the built avatar. */
export const avatarRows = (state: CliAvatarState): Array<{ key: string; value: string }> => [
  { key: "shows", value: state.kind === "built" ? (state.built?.kind === "robot" ? "robot" : "avatar") : state.kind },
  { key: "photo", value: state.hasPhoto ? "stored" : "none" },
  ...Object.entries(state.built ?? {})
    .filter(([key]) => key !== "v" && key !== "kind")
    .map(([key, value]) => ({ key, value: String(value) })),
];

/**
 * Applies `part=value` pairs to a built avatar and validates the result against its shape set. An unknown part or
 * value names what is allowed, so a person or an agent can correct the call without guessing.
 */
export const applyAvatarParts = <T extends AvatarConfig>(base: T, parts: readonly string[]): T => {
  if (parts.length === 0) throw new Error("Pass at least one part=value, for example hair=curly.");
  const schema = base.kind === "person" ? PersonAvatarSchema : RobotAvatarSchema;
  const next: Record<string, unknown> = { ...base };
  for (const part of parts) {
    const [key, value, ...rest] = part.split("=");
    if (!key || value === undefined || rest.length > 0) throw new Error(`Expected part=value, got "${part}".`);
    const field = schema.shape[key as keyof typeof schema.shape];
    if (!field || key === "v" || key === "kind") {
      const known = Object.keys(schema.shape).filter((name) => name !== "v" && name !== "kind");
      throw new Error(`Unknown part "${key}". Parts: ${known.join(", ")}.`);
    }
    const allowed = "options" in field ? (field.options as readonly string[]) : [];
    if (!allowed.includes(value)) throw new Error(`Unknown ${key} "${value}". Choose one of: ${allowed.join(", ")}.`);
    next[key] = value;
  }
  return schema.parse(next) as T;
};

const imageType = (bytes: Uint8Array): "png" | "jpeg" | "webp" | null => {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "webp";
  return null;
};

/** Reads a small square PNG, JPEG, or WebP as the data URL the API stores; the browser dialog crops, the CLI does not. */
export const readAvatarPhoto = async (file: string): Promise<string> => {
  const bytes = new Uint8Array(await readFile(file));
  const type = imageType(bytes);
  if (!type) throw new Error("The photo must be a PNG, JPEG, or WebP file.");
  if (bytes.length > MAX_AVATAR_BYTES) {
    throw new Error(
      `The photo is ${Math.ceil(bytes.length / 1024)} KiB; the limit is ${MAX_AVATAR_BYTES / 1024} KiB. Crop and shrink it first.`,
    );
  }
  return `data:image/${type};base64,${Buffer.from(bytes).toString("base64")}`;
};
