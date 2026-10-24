import { describe, expect, test } from "bun:test";
import {
  AVATAR_BACKGROUNDS,
  AvatarConfigSchema,
  canonicalAvatarConfig,
  MAX_AVATAR_CONFIG_BYTES,
  PERSON_BEARDS,
  PERSON_BROWS,
  PERSON_EXTRAS,
  PERSON_EYES,
  PERSON_FACES,
  PERSON_GLASSES,
  PERSON_HAIR_COLORS,
  PERSON_HAIRSTYLES,
  PERSON_HEADWEAR,
  PERSON_MOUTHS,
  PERSON_SKIN_TONES,
  type PersonAvatar,
  PersonAvatarSchema,
  RANDOM_PERSON_HEADWEAR,
  ROBOT_ANTENNAS,
  ROBOT_BODIES,
  ROBOT_COLORS,
  ROBOT_EYES,
  ROBOT_HEADS,
  ROBOT_MOUTHS,
  type RobotAvatar,
  randomizePersonAvatar,
  robotAvatarFromSeed,
  seededRandom,
  startPersonAvatar,
} from "../contracts/avatar";
import {
  contrastRatio,
  MOUSTACHE_PATH,
  PERSON_MOUTH_SPANS,
  personEyesMarkup,
  personFaceColors,
  personGlassesMarkup,
  personMouthMarkup,
  ROBOT_BODY_COLORS,
  renderAvatarSvg,
  renderPersonAvatar,
  renderRobotAvatar,
  robotLineColor,
} from "./avatar-art";

const person: PersonAvatar = {
  v: 1,
  kind: "person",
  face: "oval",
  skin: "s2",
  hair: "bob",
  hairColor: "red",
  eyes: "ovals",
  brows: "arched",
  mouth: "smile",
  beard: "none",
  glasses: "round",
  head: "none",
  extra: "freckles",
  bg: "sky",
};
const robot: RobotAvatar = {
  v: 1,
  kind: "robot",
  head: "square",
  antenna: "ball",
  eyes: "round",
  mouth: "grill",
  body: "light",
  color: "teal",
  bg: "sand",
};

/**
 * Every hairstyle passed a human review for unwanted associations before it shipped. A new hairstyle fails this test
 * until someone has looked at it at 20 to 96 px with every hair colour and beard, and records the review here.
 * A hard side parting with a slanted edge over the forehead is never part of the shape set (Valentin, 23.10.2026).
 */
const REVIEWED_HAIRSTYLES: Record<(typeof PERSON_HAIRSTYLES)[number], string> = {
  none: "reviewed 23.10.2026: bald, no front shape",
  short: "reviewed 23.10.2026: symmetric fringe",
  buzz: "reviewed 23.10.2026: symmetric, close to the scalp",
  curly: "reviewed 23.10.2026: symmetric curls",
  afro: "reviewed 23.10.2026: moderate round volume, symmetric",
  long: "reviewed 23.10.2026: soft centre parting",
  bob: "reviewed 23.10.2026: straight symmetric bangs",
  bun: "reviewed 23.10.2026: symmetric with bun on top",
  locs: "reviewed 23.10.2026: evenly spaced locs, symmetric",
};

describe("drawing rules", () => {
  test("every hairstyle is on the reviewed list, and nothing else is", () => {
    expect(Object.keys(REVIEWED_HAIRSTYLES).sort()).toEqual([...PERSON_HAIRSTYLES].sort());
  });

  test("the shape set has no side parting", () => {
    expect(PERSON_HAIRSTYLES as readonly string[]).not.toContain("part");
    expect(PersonAvatarSchema.safeParse({ ...person, hair: "part" }).success).toBe(false);
  });

  test("the moustache is wider than every drawn mouth, strokes included", () => {
    // Absolute SVG path commands: H carries an x, V a y, every other command x/y pairs.
    const xs = (path: string) =>
      [...path.matchAll(/([MLHVCSQTZ])([^MLHVCSQTZ]*)/g)].flatMap(([, command, values]) => {
        const numbers = (values?.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
        if (command === "H") return numbers;
        if (command === "V" || command === "Z") return [];
        return numbers.filter((_, index) => index % 2 === 0);
      });
    const moustache = xs(MOUSTACHE_PATH);
    const width = Math.max(...moustache) - Math.min(...moustache);
    for (const mouth of PERSON_MOUTHS) {
      const markup = personMouthMarkup({ ...person, mouth });
      // Measure the mouth as drawn: every x of its path or ellipse, widened by the stroke.
      const ellipse = markup.match(/cx="([\d.]+)" cy="[\d.]+" rx="([\d.]+)"/);
      const left = ellipse ? Number(ellipse[1]) - Number(ellipse[2]) : Math.min(...xs(markup.match(/d="([^"]+)"/)?.[1] ?? ""));
      const right = ellipse ? Number(ellipse[1]) + Number(ellipse[2]) : Math.max(...xs(markup.match(/d="([^"]+)"/)?.[1] ?? ""));
      const stroke = Number(markup.match(/stroke-width="([\d.]+)"/)?.[1] ?? 0);
      expect([left, right]).toEqual(PERSON_MOUTH_SPANS[mouth]);
      expect(width).toBeGreaterThanOrEqual(right - left + stroke + 4);
    }
  });

  test("random never changes the skin tone and never picks religious headwear", () => {
    const random = seededRandom("random-rules");
    for (let round = 0; round < 500; round++) {
      const next = randomizePersonAvatar(person, random);
      expect(next.skin).toBe(person.skin);
      expect(["none", ...RANDOM_PERSON_HEADWEAR]).toContain(next.head);
    }
  });
});

describe("contrast", () => {
  /** The colours a drawn fragment paints with; the best of them must separate the mark from the skin. */
  const bestContrast = (markup: string, skin: string) =>
    Math.max(...[...markup.matchAll(/(?:fill|stroke)="(#[0-9a-f]{6})"/g)].map((match) => contrastRatio(match[1]!, skin)));

  test("eyes and mouth as drawn reach 3:1 against every skin tone", () => {
    for (const skin of PERSON_SKIN_TONES) {
      const skinColor = personFaceColors(skin).skin;
      for (const eyes of PERSON_EYES) {
        const best = bestContrast(personEyesMarkup({ ...person, skin, eyes }), skinColor);
        if (best < 3) throw new Error(`eyes ${eyes} on ${skin}: ${best.toFixed(2)}:1`);
      }
      for (const mouth of PERSON_MOUTHS) {
        for (const beard of PERSON_BEARDS) {
          const best = bestContrast(personMouthMarkup({ ...person, skin, mouth, beard }), skinColor);
          if (best < 3) throw new Error(`mouth ${mouth} on ${skin}: ${best.toFixed(2)}:1`);
        }
      }
    }
  });

  test("sunglasses that cover the eyes keep 3:1 against every skin tone", () => {
    for (const skin of PERSON_SKIN_TONES) {
      const best = bestContrast(personGlassesMarkup({ ...person, skin, glasses: "sun" }), personFaceColors(skin).skin);
      if (best < 3) throw new Error(`sunglasses on ${skin}: ${best.toFixed(2)}:1`);
    }
  });

  test("the full drawing contains the measured eyes, mouth, and glasses", () => {
    for (const skin of PERSON_SKIN_TONES) {
      for (const glasses of PERSON_GLASSES) {
        const config = { ...person, skin, glasses };
        const markup = renderPersonAvatar(config);
        for (const fragment of [personEyesMarkup(config), personMouthMarkup(config), personGlassesMarkup(config)]) {
          expect(markup).toContain(fragment);
        }
      }
    }
  });

  test("robot lines reach 3:1 against every body colour", () => {
    for (const color of ROBOT_COLORS) expect(contrastRatio(robotLineColor(color), ROBOT_BODY_COLORS[color])).toBeGreaterThanOrEqual(3);
  });
});

describe("rendering", () => {
  test("crops only to fixed view boxes", () => {
    expect(renderPersonAvatar(person, "thumbnail")).toContain('viewBox="12 2 72 72"');
    expect(renderRobotAvatar(robot, "thumbnail")).toContain('viewBox="8 0 80 80"');
  });

  test("is deterministic and contains only shapes", () => {
    for (const config of [person, robot] as const) {
      const markup = renderAvatarSvg(config);
      expect(renderAvatarSvg(structuredClone(config))).toBe(markup);
      expect(markup.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">')).toBe(true);
      expect(markup).not.toMatch(/<(script|text|image|use|foreignObject|style|a)\b|href|on[a-z]+=|url\(/i);
      expect(markup.length).toBeLessThan(8_000);
    }
  });

  test("draws every option of every part", () => {
    const parts: [keyof PersonAvatar, readonly string[]][] = [
      ["face", PERSON_FACES],
      ["skin", PERSON_SKIN_TONES],
      ["hair", PERSON_HAIRSTYLES],
      ["hairColor", PERSON_HAIR_COLORS],
      ["eyes", PERSON_EYES],
      ["brows", PERSON_BROWS],
      ["mouth", PERSON_MOUTHS],
      ["beard", PERSON_BEARDS],
      ["glasses", PERSON_GLASSES],
      ["head", PERSON_HEADWEAR],
      ["extra", PERSON_EXTRAS],
      ["bg", AVATAR_BACKGROUNDS],
    ];
    for (const [part, options] of parts) {
      const drawings = new Set(options.map((option) => renderPersonAvatar({ ...person, [part]: option } as PersonAvatar)));
      expect(drawings.size).toBe(options.length);
    }
    const robotParts: [keyof RobotAvatar, readonly string[]][] = [
      ["head", ROBOT_HEADS],
      ["antenna", ROBOT_ANTENNAS],
      ["eyes", ROBOT_EYES],
      ["mouth", ROBOT_MOUTHS],
      ["body", ROBOT_BODIES],
      ["color", ROBOT_COLORS],
      ["bg", AVATAR_BACKGROUNDS],
    ];
    for (const [part, options] of robotParts) {
      const drawings = new Set(options.map((option) => renderRobotAvatar({ ...robot, [part]: option } as RobotAvatar)));
      expect(drawings.size).toBe(options.length);
    }
  });

  test("keeps rendering a stored version 1 config byte for byte", () => {
    // A stored avatar must not change by itself. If this fails on purpose, raise AVATAR_RENDERER_REVISION.
    const digest = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
    expect(digest(renderAvatarSvg(person))).toMatchSnapshot();
    expect(digest(renderAvatarSvg(robot))).toMatchSnapshot();
  });
});

describe("configs", () => {
  test("a seed always draws the same robot, also after the shape set grows", () => {
    // Fixed vectors: a change here changes every agent's robot. Browsers run the same vectors in the dialog tests.
    expect(robotAvatarFromSeed("0b2f5c7e-0000-4000-8000-000000000001")).toEqual({
      v: 1,
      kind: "robot",
      head: "capsule",
      antenna: "ball",
      eyes: "visor",
      mouth: "smile",
      body: "panel",
      color: "graphite",
      bg: "rose",
    });
    expect(robotAvatarFromSeed("agent-0")).toEqual({
      v: 1,
      kind: "robot",
      head: "tv",
      antenna: "ball",
      eyes: "pixel",
      mouth: "grill",
      body: "panel",
      color: "coral",
      bg: "mint",
    });
    expect(robotAvatarFromSeed("Ünïcødé 🤖")).toEqual({
      v: 1,
      kind: "robot",
      head: "capsule",
      antenna: "ball",
      eyes: "visor",
      mouth: "none",
      body: "light",
      color: "yellow",
      bg: "teal",
    });
    const robots = new Set(Array.from({ length: 40 }, (_, index) => JSON.stringify(robotAvatarFromSeed(`agent-${index}`))));
    expect(robots.size).toBeGreaterThan(30);
    for (const value of robots) expect(AvatarConfigSchema.safeParse(JSON.parse(value)).success).toBe(true);
  });

  test("a first draft is a valid plain face", () => {
    const draft = startPersonAvatar(seededRandom("start"));
    expect(PersonAvatarSchema.parse(draft)).toEqual(draft);
    expect([draft.beard, draft.glasses, draft.head, draft.extra]).toEqual(["none", "none", "none", "none"]);
  });

  test("rejects unknown parts and stays small", () => {
    expect(AvatarConfigSchema.safeParse({ ...person, hat: "crown" }).success).toBe(false);
    expect(AvatarConfigSchema.safeParse({ ...person, v: 2 }).success).toBe(false);
    expect(AvatarConfigSchema.safeParse({ ...robot, hair: "short" }).success).toBe(false);
    expect(new TextEncoder().encode(canonicalAvatarConfig(person)).length).toBeLessThan(MAX_AVATAR_CONFIG_BYTES);
    expect(canonicalAvatarConfig({ ...person })).toBe(canonicalAvatarConfig(JSON.parse(JSON.stringify(person))));
  });
});
