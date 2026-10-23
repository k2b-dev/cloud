import { z } from "zod";

/**
 * The shape set of built avatars: a person's comic avatar and an agent's robot. A stored config names one option per
 * part by a stable id. Ids are never removed or renamed once released, so every stored config keeps rendering; new
 * options only add ids. `v` changes only when the schema itself breaks, and each version keeps its own schema and
 * drawing.
 */
export const AVATAR_SHAPE_SET_VERSION = 1;

export const PERSON_FACES = ["round", "oval", "square"] as const;
export const PERSON_SKIN_TONES = ["s1", "s2", "s3", "s4", "s5", "s6"] as const;
/** Every hairstyle passed a human review for unwanted associations; see the review list in the renderer tests. */
export const PERSON_HAIRSTYLES = ["none", "short", "buzz", "curly", "afro", "long", "bob", "bun", "locs"] as const;
export const PERSON_HAIR_COLORS = ["black", "dark", "brown", "blond", "red", "grey", "white", "blue", "pink"] as const;
export const PERSON_EYES = ["dots", "ovals", "happy", "wink", "calm"] as const;
export const PERSON_BROWS = ["none", "straight", "arched", "thick", "raised"] as const;
export const PERSON_MOUTHS = ["smile", "grin", "neutral", "oh", "smirk"] as const;
export const PERSON_BEARDS = ["none", "stubble", "moustache", "goatee", "full"] as const;
export const PERSON_GLASSES = ["none", "round", "square", "half", "sun"] as const;
export const PERSON_HEADWEAR = ["none", "beanie", "cap", "hijab", "turban", "kippa", "phones"] as const;
export const PERSON_EXTRAS = ["none", "freckles", "blush", "earrings", "mole"] as const;
export const AVATAR_BACKGROUNDS = ["sky", "mint", "sand", "rose", "lilac", "stone", "peach", "teal"] as const;

export const ROBOT_HEADS = ["square", "round", "capsule", "tv"] as const;
export const ROBOT_ANTENNAS = ["none", "ball", "double", "dish"] as const;
export const ROBOT_EYES = ["round", "visor", "pixel", "cyclops", "happy"] as const;
export const ROBOT_MOUTHS = ["grill", "smile", "led", "line", "none"] as const;
export const ROBOT_BODIES = ["plain", "panel", "light", "buttons"] as const;
export const ROBOT_COLORS = ["steel", "white", "blue", "teal", "coral", "yellow", "purple", "graphite"] as const;

export const PersonAvatarSchema = z
  .object({
    v: z.literal(AVATAR_SHAPE_SET_VERSION),
    kind: z.literal("person"),
    face: z.enum(PERSON_FACES),
    skin: z.enum(PERSON_SKIN_TONES),
    hair: z.enum(PERSON_HAIRSTYLES),
    hairColor: z.enum(PERSON_HAIR_COLORS),
    eyes: z.enum(PERSON_EYES),
    brows: z.enum(PERSON_BROWS),
    mouth: z.enum(PERSON_MOUTHS),
    beard: z.enum(PERSON_BEARDS),
    glasses: z.enum(PERSON_GLASSES),
    head: z.enum(PERSON_HEADWEAR),
    extra: z.enum(PERSON_EXTRAS),
    bg: z.enum(AVATAR_BACKGROUNDS),
  })
  .strict();
export type PersonAvatar = z.infer<typeof PersonAvatarSchema>;

export const RobotAvatarSchema = z
  .object({
    v: z.literal(AVATAR_SHAPE_SET_VERSION),
    kind: z.literal("robot"),
    head: z.enum(ROBOT_HEADS),
    antenna: z.enum(ROBOT_ANTENNAS),
    eyes: z.enum(ROBOT_EYES),
    mouth: z.enum(ROBOT_MOUTHS),
    body: z.enum(ROBOT_BODIES),
    color: z.enum(ROBOT_COLORS),
    bg: z.enum(AVATAR_BACKGROUNDS),
  })
  .strict();
export type RobotAvatar = z.infer<typeof RobotAvatarSchema>;

export const AvatarConfigSchema = z.discriminatedUnion("kind", [PersonAvatarSchema, RobotAvatarSchema]);
export type AvatarConfig = z.infer<typeof AvatarConfigSchema>;

/** Which picture others see: an uploaded photo, the built avatar, or the fallback (initials for people). */
export const AVATAR_KINDS = ["photo", "built", "initials"] as const;
export type AvatarKind = (typeof AVATAR_KINDS)[number];

/** A stored config is a handful of short ids; anything larger than this is not a config. */
export const MAX_AVATAR_CONFIG_BYTES = 1024;

/** The JSON text whose hash identifies a built avatar: keys in schema order, so equal configs hash equally. */
export const canonicalAvatarConfig = (config: AvatarConfig): string =>
  JSON.stringify(config.kind === "person" ? PersonAvatarSchema.parse(config) : RobotAvatarSchema.parse(config));

type Random = () => number;

const pick = <T>(list: readonly T[], random: Random): T => list[Math.floor(random() * list.length) % list.length] as T;

/** A first draft for a person: random, with a calm smile and nothing on top, so the person starts from a plain face. */
export const startPersonAvatar = (random: Random = Math.random): PersonAvatar => ({
  v: AVATAR_SHAPE_SET_VERSION,
  kind: "person",
  face: pick(PERSON_FACES, random),
  skin: pick(PERSON_SKIN_TONES, random),
  hair: pick(PERSON_HAIRSTYLES.slice(1), random),
  hairColor: pick(PERSON_HAIR_COLORS.slice(0, 6), random),
  eyes: pick(PERSON_EYES, random),
  brows: pick(PERSON_BROWS.slice(1), random),
  mouth: "smile",
  beard: "none",
  glasses: "none",
  head: "none",
  extra: "none",
  bg: pick(AVATAR_BACKGROUNDS, random),
});

/** Headwear the random button may choose; religious headwear is only ever the person's own choice. */
export const RANDOM_PERSON_HEADWEAR = ["beanie", "cap", "phones"] as const;

/** "Random" in the builder: everything changes except the skin tone, which stays the person's choice. */
export const randomizePersonAvatar = (current: PersonAvatar, random: Random = Math.random): PersonAvatar => {
  const maybe = <T extends string>(chance: number, list: readonly T[]): T | "none" => (random() < chance ? pick(list, random) : "none");
  return {
    v: AVATAR_SHAPE_SET_VERSION,
    kind: "person",
    face: pick(PERSON_FACES, random),
    skin: current.skin,
    hair: pick(PERSON_HAIRSTYLES.slice(1), random),
    hairColor: random() < 0.85 ? pick(PERSON_HAIR_COLORS.slice(0, 7), random) : pick(PERSON_HAIR_COLORS, random),
    eyes: pick(PERSON_EYES, random),
    brows: pick(PERSON_BROWS.slice(1), random),
    mouth: pick(PERSON_MOUTHS, random),
    beard: maybe(0.3, PERSON_BEARDS.slice(1)),
    glasses: maybe(0.35, PERSON_GLASSES.slice(1)),
    head: maybe(0.25, RANDOM_PERSON_HEADWEAR),
    extra: maybe(0.35, PERSON_EXTRAS.slice(1)),
    bg: pick(AVATAR_BACKGROUNDS, random),
  };
};

export const randomRobotAvatar = (random: Random = Math.random): RobotAvatar => ({
  v: AVATAR_SHAPE_SET_VERSION,
  kind: "robot",
  head: pick(ROBOT_HEADS, random),
  antenna: pick(ROBOT_ANTENNAS, random),
  eyes: pick(ROBOT_EYES, random),
  mouth: pick(ROBOT_MOUTHS, random),
  body: pick(ROBOT_BODIES, random),
  color: pick(ROBOT_COLORS, random),
  bg: pick(AVATAR_BACKGROUNDS, random),
});

/** A small seeded generator (cyrb53 seed, mulberry32 stream): the same seed draws the same robot everywhere. */
export const seededRandom = (seed: string): Random => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < seed.length; index++) {
    const code = seed.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  let state = (Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * The parts a seed draws from, frozen at shape set 1. New robot options join the builder, never this list, so an
 * agent's robot never changes when the shape set grows.
 */
const ROBOT_SEED_PARTS_V1 = {
  head: ["square", "round", "capsule", "tv"],
  antenna: ["none", "ball", "double", "dish"],
  eyes: ["round", "visor", "pixel", "cyclops", "happy"],
  mouth: ["grill", "smile", "led", "line", "none"],
  body: ["plain", "panel", "light", "buttons"],
  color: ["steel", "white", "blue", "teal", "coral", "yellow", "purple", "graphite"],
  bg: ["sky", "mint", "sand", "rose", "lilac", "stone", "peach", "teal"],
} as const satisfies { [Part in Exclude<keyof RobotAvatar, "v" | "kind">]: readonly RobotAvatar[Part][] };

/** The robot an agent shows until someone changes it: drawn from its account id, so it never changes by itself. */
export const robotAvatarFromSeed = (seed: string): RobotAvatar => {
  const random = seededRandom(seed);
  return {
    v: AVATAR_SHAPE_SET_VERSION,
    kind: "robot",
    head: pick(ROBOT_SEED_PARTS_V1.head, random),
    antenna: pick(ROBOT_SEED_PARTS_V1.antenna, random),
    eyes: pick(ROBOT_SEED_PARTS_V1.eyes, random),
    mouth: pick(ROBOT_SEED_PARTS_V1.mouth, random),
    body: pick(ROBOT_SEED_PARTS_V1.body, random),
    color: pick(ROBOT_SEED_PARTS_V1.color, random),
    bg: pick(ROBOT_SEED_PARTS_V1.bg, random),
  };
};
