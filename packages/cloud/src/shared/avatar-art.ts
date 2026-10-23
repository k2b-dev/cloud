import type { AvatarConfig, PersonAvatar, RobotAvatar } from "../contracts/avatar";

/**
 * Draws built avatars as SVG: flat shapes on a 96 × 96 canvas with their own background, so they read the same on light
 * and dark surfaces. The server serves this markup under the account's avatar URL and the browser previews the same
 * markup while someone builds, so both always agree. The output contains only shapes drawn from fixed ids: no text,
 * no links, no scripts and no input from the config other than ids.
 *
 * Raise `AVATAR_RENDERER_REVISION` whenever a drawing changes, so stored avatars get a new hash and caches refetch.
 */
export const AVATAR_RENDERER_REVISION = 1;

type Swatch = { id: string; color: string };

/** Skin tones from light to very dark. */
export const SKIN_TONE_COLORS: Record<PersonAvatar["skin"], string> = {
  s1: "#f6dcc9",
  s2: "#eec19d",
  s3: "#d79f70",
  s4: "#b67a4c",
  s5: "#8b5a37",
  s6: "#5c3a24",
};

export const HAIR_COLORS: Record<PersonAvatar["hairColor"], string> = {
  black: "#26201d",
  dark: "#4b3024",
  brown: "#83522f",
  blond: "#dcaa52",
  red: "#b9532d",
  grey: "#9c9a98",
  white: "#e9e6e0",
  blue: "#3f6fd6",
  pink: "#df749e",
};

/** One choice sets the background and the matching clothing and headwear colour. */
export const BACKGROUND_COLORS: Record<PersonAvatar["bg"], { background: string; accent: string }> = {
  sky: { background: "#d7e8fb", accent: "#2f6fd0" },
  mint: { background: "#d3efe1", accent: "#1d9268" },
  sand: { background: "#f5e6c6", accent: "#c0802a" },
  rose: { background: "#f7dbe1", accent: "#cc506c" },
  lilac: { background: "#e5defa", accent: "#7354d4" },
  stone: { background: "#e6e4e1", accent: "#57534e" },
  peach: { background: "#fbe0cf", accent: "#d9632f" },
  teal: { background: "#cdeded", accent: "#15837f" },
};

export const ROBOT_BODY_COLORS: Record<RobotAvatar["color"], string> = {
  steel: "#9aa5b1",
  white: "#e4e7eb",
  blue: "#5b8def",
  teal: "#2fb5a8",
  coral: "#f07a5f",
  yellow: "#f2c03a",
  purple: "#9b7be8",
  graphite: "#4b5563",
};

/** Swatches for pickers, in shape-set order. */
export const avatarSwatches = {
  skin: Object.entries(SKIN_TONE_COLORS).map(([id, color]) => ({ id, color })) as Swatch[],
  hairColor: Object.entries(HAIR_COLORS).map(([id, color]) => ({ id, color })) as Swatch[],
  bg: Object.entries(BACKGROUND_COLORS).map(([id, colors]) => ({ id, color: colors.background })) as Swatch[],
  robotColor: Object.entries(ROBOT_BODY_COLORS).map(([id, color]) => ({ id, color })) as Swatch[],
};

/** Darkens (`amount` towards black) or lightens (`towardsWhite`) a hex colour. */
export const mixColor = (hex: string, amount: number, towardsWhite = false): string => {
  const value = Number.parseInt(hex.slice(1), 16);
  const target = towardsWhite ? 255 : 0;
  const channel = (shift: number) => {
    const current = (value >> shift) & 255;
    return Math.round(current + (target - current) * amount);
  };
  return `#${((1 << 24) | (channel(16) << 16) | (channel(8) << 8) | channel(0)).toString(16).slice(1)}`;
};

/** WCAG relative luminance of a hex colour. */
export const relativeLuminance = (hex: string): number => {
  const value = Number.parseInt(hex.slice(1), 16);
  const linear = (channel: number) => {
    const srgb = channel / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear((value >> 16) & 255) + 0.7152 * linear((value >> 8) & 255) + 0.0722 * linear(value & 255);
};

export const contrastRatio = (a: string, b: string): number => {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};

/** Alpha-blends `top` over `bottom`; used where a face mark is drawn half transparent. */
export const blendColor = (top: string, bottom: string, alpha: number): string => {
  const t = Number.parseInt(top.slice(1), 16);
  const b = Number.parseInt(bottom.slice(1), 16);
  const channel = (shift: number) => Math.round(((t >> shift) & 255) * alpha + ((b >> shift) & 255) * (1 - alpha));
  return `#${((1 << 24) | (channel(16) << 16) | (channel(8) << 8) | channel(0)).toString(16).slice(1)}`;
};

const INK = "#1a1311";
const LIP = "#d99a8c";
const SCLERA_ALPHA = 0.8;

/**
 * The colours of the face marks on one skin tone. Lines use the dark ink where it reaches 3:1 against the skin and a
 * warm light tone where it does not, so eyes and mouth stay readable on every skin tone.
 */
export const personFaceColors = (skin: PersonAvatar["skin"]) => {
  const skinColor = SKIN_TONE_COLORS[skin];
  const line = contrastRatio(INK, skinColor) >= 3 ? INK : LIP;
  return { skin: skinColor, ink: INK, line, sclera: blendColor("#ffffff", skinColor, SCLERA_ALPHA) };
};

/** The horizontal span of each mouth; the drawing uses these numbers, and the moustache is wider than every one. */
export const PERSON_MOUTH_SPANS: Record<PersonAvatar["mouth"], [number, number]> = {
  smile: [41, 55],
  grin: [40, 56],
  neutral: [42, 54],
  oh: [45, 51],
  smirk: [42, 55],
};
const MOUSTACHE_LEFT = 36.5;
const MOUSTACHE_RIGHT = 59.5;
/** A curved moustache wider than the mouth; never a narrow block under the nose. */
export const MOUSTACHE_PATH = `M${MOUSTACHE_LEFT} 59.5C${MOUSTACHE_LEFT + 3.5} 54.5 45 54.8 48 57C51 54.8 ${MOUSTACHE_RIGHT - 3.5} 54.5 ${MOUSTACHE_RIGHT} 59.5C${MOUSTACHE_RIGHT - 4.5} 60.6 51.5 59.6 48 58.8C44.5 59.6 ${MOUSTACHE_LEFT + 4.5} 60.6 ${MOUSTACHE_LEFT} 59.5Z`;

/** Front hair shapes. Every one is symmetric or soft; a hard side parting is not part of the shape set. */
const HAIR_FRONT: Partial<Record<PersonAvatar["hair"], string>> = {
  short: "M25 44C23 25 34 17 48 17S73 25 71 44C67 33 59 28 48 28S29 33 25 44Z",
  buzz: "M26.5 38C27.5 24 36 19.5 48 19.5S68.5 24 69.5 38C65 30 57 27 48 27S31 30 26.5 38Z",
  long: "M25 44C24 26 34 17 48 17S71 24 71.5 42C63 35 55 27 48 24C42 30 32 36 25 44Z",
  bob: "M25 40C24 22 36 16 48 16S72 22 71 40C64 36 56 34 48 34S32 36 25 40Z",
  bun: "M25 44C23 25 34 17 48 17S73 25 71 44C67 33 59 28 48 28S29 33 25 44Z",
  locs: "M25 42C24 24 35 17 48 17S72 24 71 42C66 33 58 29 48 29S30 33 25 42Z",
  afro: "M25 42C24 24 35 17 48 17S72 24 71 42C66 33 58 29 48 29S30 33 25 42Z",
};
const CURLS: [number, number][] = [
  [27.7, 35.1],
  [31.9, 27.8],
  [39.1, 22.8],
  [48, 21],
  [56.9, 22.8],
  [64.1, 27.8],
  [68.3, 35.1],
];

const hasMoustache = (config: PersonAvatar) => config.beard === "moustache" || config.beard === "goatee" || config.beard === "full";

/** The mouth, drawn from its span in `PERSON_MOUTH_SPANS`. */
export const personMouthMarkup = (config: PersonAvatar): string => {
  const { ink, line } = personFaceColors(config.skin);
  const [left, right] = PERSON_MOUTH_SPANS[config.mouth];
  const y = hasMoustache(config) ? 1.5 : 0;
  const stroke = (d: string) => `<path d="${d}" fill="none" stroke="${line}" stroke-width="2.4" stroke-linecap="round"/>`;
  if (config.mouth === "smile") return stroke(`M${left} ${60 + y}Q48 ${66 + y} ${right} ${60 + y}`);
  if (config.mouth === "grin")
    return `<path d="M${left} ${59 + y}H${right}Q${right - 1} ${68 + y} 48 ${68 + y}T${left} ${59 + y}Z" fill="${ink}"/><path d="M${left + 2} ${59.4 + y}H${right - 2}V${61.2 + y}Q48 ${62.2 + y} ${left + 2} ${61.2 + y}Z" fill="#ffffff"/>`;
  if (config.mouth === "neutral") return stroke(`M${left} ${62 + y}H${right}`);
  if (config.mouth === "oh")
    return `<ellipse cx="48" cy="${62 + y}" rx="${(right - left) / 2}" ry="3.6" fill="${ink}" stroke="${line}" stroke-width="1.2"/>`;
  return stroke(`M${left} ${62 + y}Q50 ${64 + y} ${right} ${59 + y}`);
};

/** Both eyes; open eyes sit on a light sclera, closed eyes are lines in the contrasting line colour. */
export const personEyesMarkup = (config: PersonAvatar): string => {
  const { ink, line, sclera } = personFaceColors(config.skin);
  const scleraMark = (x: number) => `<ellipse cx="${x}" cy="47" rx="3.7" ry="4.3" fill="${sclera}"/>`;
  const oval = (x: number) =>
    `${scleraMark(x)}<ellipse cx="${x}" cy="47" rx="2.5" ry="3.4" fill="${ink}"/><circle cx="${x + 0.9}" cy="45.8" r=".9" fill="#ffffff"/>`;
  const lid = (d: string) => `<path d="${d}" fill="none" stroke="${line}" stroke-width="2.3" stroke-linecap="round"/>`;
  const happy = (x: number) => lid(`M${x - 4} 48.5Q${x} 44 ${x + 4} 48.5`);
  const eye = (x: number) => {
    if (config.eyes === "dots") return `${scleraMark(x)}<circle cx="${x}" cy="47" r="2.9" fill="${ink}"/>`;
    if (config.eyes === "ovals") return oval(x);
    if (config.eyes === "happy") return happy(x);
    return lid(`M${x - 4} 46.5Q${x} 50.5 ${x + 4} 46.5`);
  };
  return config.eyes === "wink" ? oval(39) + happy(57) : eye(39) + eye(57);
};

/** Glasses. Sunglasses cover the eyes, so on dark skin their lenses get an outline in the contrasting line colour. */
export const personGlassesMarkup = (config: PersonAvatar): string => {
  const { ink, line } = personFaceColors(config.skin);
  const frame = `fill="none" stroke="${ink}" stroke-width="2"`;
  if (config.glasses === "round")
    return `<circle cx="39" cy="47" r="6.4" ${frame}/><circle cx="57" cy="47" r="6.4" ${frame}/><path d="M45.4 46.5Q48 45 50.6 46.5M32.6 46L27 45M63.4 46L69 45" ${frame}/>`;
  if (config.glasses === "square")
    return `<rect x="31.5" y="41.8" width="15" height="10.8" rx="3" ${frame}/><rect x="49.5" y="41.8" width="15" height="10.8" rx="3" ${frame}/><path d="M46.5 46H49.5M31.5 45.5L27 45M64.5 45.5L69 45" ${frame}/>`;
  if (config.glasses === "half")
    return `<path d="M31.5 43.5Q39 40.5 46.5 43.5M49.5 43.5Q57 40.5 64.5 43.5" fill="none" stroke="${ink}" stroke-width="3"/><path d="M31.5 44Q32 53 39 53T46.5 44M49.5 44Q50 53 57 53T64.5 44M46.5 44.5H49.5" fill="none" stroke="${ink}" stroke-width="1.1" opacity=".7"/>`;
  if (config.glasses === "sun") {
    const outline = line === ink ? "" : ` stroke="${line}" stroke-width="1.4"`;
    return `<path d="M31 43H47V47Q47 54 39 54T31 47ZM49 43H65V47Q65 54 57 54T49 47Z" fill="${ink}"${outline}/><path d="M47 44.5H49M31 44L27 44.5M65 44L69 44.5" ${frame}/>`;
  }
  return "";
};

/** Fixed crops: the whole avatar, or the head for option thumbnails in a picker. */
export const AVATAR_CROPS = { full: "0 0 96 96", personThumbnail: "12 2 72 72", robotThumbnail: "8 0 80 80" } as const;
export type AvatarCrop = "full" | "thumbnail";

const svg = (parts: string[], viewBox: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="96" height="96">${parts.join("")}</svg>`;

export function renderPersonAvatar(config: PersonAvatar, crop: AvatarCrop = "full"): string {
  const { skin: skinColor } = personFaceColors(config.skin);
  const skinShade = mixColor(skinColor, 0.13);
  const hair = HAIR_COLORS[config.hairColor];
  const hairBack = mixColor(hair, 0.12);
  const { background, accent } = BACKGROUND_COLORS[config.bg];
  const accentShade = mixColor(accent, 0.18);
  const hidesHair = config.head === "hijab" || config.head === "turban";
  const hidesFrontHair = hidesHair || config.head === "beanie";
  const p: string[] = [`<rect width="96" height="96" fill="${background}"/>`];

  if (!hidesHair) {
    if (config.hair === "afro") p.push(`<circle cx="48" cy="37" r="31" fill="${hairBack}"/>`);
    if (config.hair === "long") p.push(`<path d="M22 46C20 22 33 13 48 13S76 22 74 46L77 86C64 92 32 92 19 86Z" fill="${hairBack}"/>`);
    if (config.hair === "bob")
      p.push(`<path d="M21 46C19 22 33 13 48 13S77 22 75 46L76 68C70 72 65 71 63 66H33C31 71 26 72 20 68Z" fill="${hairBack}"/>`);
    if (config.hair === "locs") {
      for (let x = 20; x <= 72; x += 6.5)
        p.push(`<rect x="${x}" y="26" width="6" height="${x < 30 || x > 64 ? 58 : 44}" rx="3" fill="${hairBack}"/>`);
    }
  }

  p.push(`<path d="M12 98C14 83 28 76 48 76S82 83 84 98Z" fill="${accent}"/>`);
  if (config.head === "hijab") {
    p.push(`<path d="M17 96C12 64 17 15 48 13S84 64 79 96Z" fill="${accent}"/>`);
  } else {
    p.push(`<rect x="41" y="60" width="14" height="19" rx="4" fill="${skinShade}"/><path d="M40 76Q48 84 56 76" fill="${skinShade}"/>`);
  }

  const earX = config.face === "oval" ? 27 : config.face === "square" ? 26 : 25.5;
  if (config.head !== "hijab") {
    p.push(`<circle cx="${earX}" cy="48" r="5.2" fill="${skinColor}"/><circle cx="${96 - earX}" cy="48" r="5.2" fill="${skinColor}"/>`);
  }
  if (config.face === "square") p.push(`<rect x="26" y="21" width="44" height="50" rx="15" fill="${skinColor}"/>`);
  else if (config.face === "oval") p.push(`<ellipse cx="48" cy="46" rx="21" ry="27" fill="${skinColor}"/>`);
  else p.push(`<ellipse cx="48" cy="46" rx="22.5" ry="25" fill="${skinColor}"/>`);

  if (config.extra === "blush")
    p.push(`<circle cx="34" cy="56" r="4.5" fill="#f07a7a" opacity=".32"/><circle cx="62" cy="56" r="4.5" fill="#f07a7a" opacity=".32"/>`);
  if (config.extra === "freckles") {
    const freckle = mixColor(skinColor, 0.32);
    for (const [x, y] of [
      [33, 53],
      [36, 55.5],
      [31, 56],
      [63, 53],
      [60, 55.5],
      [65, 56],
    ])
      p.push(`<circle cx="${x}" cy="${y}" r="1" fill="${freckle}"/>`);
  }
  if (config.extra === "mole") p.push(`<circle cx="60" cy="61" r="1.2" fill="${mixColor(skinColor, 0.45)}"/>`);
  p.push(`<ellipse cx="48" cy="53.5" rx="2.6" ry="2" fill="${skinShade}"/>`);

  if (config.beard === "stubble")
    p.push(`<path d="M27 52C28 68 38 74 48 74S68 68 69 52C64 62 58 66 48 66S32 62 27 52Z" fill="${hair}" opacity=".3"/>`);
  if (config.beard === "full")
    p.push(
      `<path d="M25 47C25 68 36 78 48 78S71 68 71 47C68 56 64 60 60 58S52 56 48 56S40 56 36 58S28 56 25 47Z" fill="${hair}"/><ellipse cx="48" cy="61" rx="6.5" ry="3.4" fill="${skinColor}"/>`,
    );
  if (config.beard === "goatee") p.push(`<path d="M42.5 64C43.5 71 52.5 71 53.5 64Q48 66.5 42.5 64Z" fill="${hair}"/>`);
  if (hasMoustache(config)) p.push(`<path d="${MOUSTACHE_PATH}" fill="${hair}"/>`);

  p.push(personMouthMarkup(config), personEyesMarkup(config));

  const browColor = mixColor(config.hairColor === "white" ? "#a8a49e" : hair, 0.25);
  const brows: Record<Exclude<PersonAvatar["brows"], "none">, [string, string, number]> = {
    straight: ["M35 39.5H43", "M53 39.5H61", 2.4],
    arched: ["M35 40.5Q39 36.5 43 39.5", "M53 39.5Q57 36.5 61 40.5", 2.4],
    thick: ["M34.5 40.5L43.5 39", "M52.5 39L61.5 40.5", 3.8],
    raised: ["M35 37.5Q39 34 43 37", "M53 39.5H61", 2.4],
  };
  if (config.brows !== "none") {
    const [left, right, width] = brows[config.brows];
    p.push(`<path d="${left}${right}" fill="none" stroke="${browColor}" stroke-width="${width}" stroke-linecap="round"/>`);
  }

  if (!hidesFrontHair) {
    if (config.hair === "bun") p.push(`<circle cx="48" cy="14" r="8.5" fill="${hair}"/>`);
    if (config.hair === "curly") {
      p.push(`<path d="M25 44C23 25 34 18 48 18S73 25 71 44C67 34 59 30 48 30S29 34 25 44Z" fill="${hair}"/>`);
      for (const [x, cy] of CURLS) p.push(`<circle cx="${x}" cy="${cy}" r="7.4" fill="${hair}"/>`);
    } else {
      const front = HAIR_FRONT[config.hair];
      if (front) p.push(`<path d="${front}" fill="${hair}"${config.hair === "buzz" ? ' opacity=".9"' : ""}/>`);
    }
  }

  if (config.head === "beanie")
    p.push(
      `<path d="M23 42C22 18 35 11 48 11S74 18 73 42Z" fill="${accent}"/><rect x="21" y="34" width="54" height="10" rx="5" fill="${accentShade}"/><circle cx="48" cy="9" r="4.5" fill="${accentShade}"/>`,
    );
  if (config.head === "cap")
    p.push(
      `<path d="M24 38C24 20 35 13 48 13S72 20 72 38Z" fill="${accent}"/><path d="M24 37C38 32.5 62 33 81 39.5C73 44 57 41.5 47 40.5S29 40 24 37Z" fill="${accentShade}"/>`,
    );
  if (config.head === "hijab")
    p.push(`<path d="M24 47C21 24 34 15 48 15S75 24 72 47C69 33 60 27 48 27S27 33 24 47Z" fill="${accentShade}"/>`);
  if (config.head === "turban")
    p.push(
      `<path d="M22 42C18 18 34 9 48 10S78 18 74 42C68 33 58 29 48 33C38 29 28 33 22 42Z" fill="${accent}"/><path d="M29 23Q48 35 67 20" fill="none" stroke="${accentShade}" stroke-width="2.6" stroke-linecap="round"/>`,
    );
  if (config.head === "kippa") p.push(`<path d="M38 22.5Q48 13 58 22.5Q48 20 38 22.5Z" fill="${accent}"/>`);
  if (config.head === "phones")
    p.push(
      `<path d="M24 45C21 14 75 14 72 45" fill="none" stroke="#3a3330" stroke-width="3.4"/><rect x="18.5" y="40" width="9" height="15" rx="4.5" fill="#3a3330"/><rect x="68.5" y="40" width="9" height="15" rx="4.5" fill="#3a3330"/>`,
    );

  p.push(personGlassesMarkup(config));
  if (config.extra === "earrings" && config.head !== "hijab")
    p.push(`<circle cx="${earX}" cy="55" r="2" fill="#e2b13c"/><circle cx="${96 - earX}" cy="55" r="2" fill="#e2b13c"/>`);

  return svg(p, crop === "full" ? AVATAR_CROPS.full : AVATAR_CROPS.personThumbnail);
}

const SCREEN = "#1f2430";
const LIGHT = "#fbbf24";
const GLOW = "#7dd3fc";

/** Lines on a robot: light on dark bodies, dark on light ones. */
export const robotLineColor = (color: RobotAvatar["color"]): string =>
  relativeLuminance(ROBOT_BODY_COLORS[color]) < 0.2 ? "#f8fafc" : SCREEN;

export function renderRobotAvatar(config: RobotAvatar, crop: AvatarCrop = "full"): string {
  const body = ROBOT_BODY_COLORS[config.color];
  const shade = mixColor(body, 0.2);
  const line = robotLineColor(config.color);
  const heads: Record<RobotAvatar["head"], { top: number; shape: string }> = {
    square: { top: 22, shape: `<rect x="22" y="22" width="52" height="44" rx="12" fill="${body}"/>` },
    round: { top: 19, shape: `<circle cx="48" cy="44" r="25" fill="${body}"/>` },
    capsule: { top: 26, shape: `<rect x="20" y="26" width="56" height="38" rx="19" fill="${body}"/>` },
    tv: {
      top: 20,
      shape: `<rect x="24" y="20" width="48" height="46" rx="7" fill="${body}"/><rect x="28" y="24" width="40" height="38" rx="5" fill="${mixColor(body, 0.08, true)}"/>`,
    },
  };
  const { top, shape } = heads[config.head];
  const p: string[] = [`<rect width="96" height="96" fill="${BACKGROUND_COLORS[config.bg].background}"/>`];

  if (config.antenna === "ball")
    p.push(
      `<path d="M48 ${top + 2}V${top - 8}" stroke="${shade}" stroke-width="3" stroke-linecap="round"/><circle cx="48" cy="${top - 11}" r="4.2" fill="${LIGHT}"/>`,
    );
  if (config.antenna === "double")
    p.push(
      `<path d="M40 ${top + 3}L34 ${top - 7}M56 ${top + 3}L62 ${top - 7}" stroke="${shade}" stroke-width="3" stroke-linecap="round"/><circle cx="33" cy="${top - 9}" r="3.2" fill="${LIGHT}"/><circle cx="63" cy="${top - 9}" r="3.2" fill="${LIGHT}"/>`,
    );
  if (config.antenna === "dish")
    p.push(
      `<path d="M48 ${top + 2}V${top - 5}" stroke="${shade}" stroke-width="3"/><path d="M38 ${top - 5}Q48 ${top - 17} 58 ${top - 5}Z" fill="${shade}"/>`,
    );

  p.push(
    `<rect x="42" y="60" width="12" height="16" rx="3" fill="${shade}"/><rect x="16" y="74" width="64" height="34" rx="14" fill="${body}"/>`,
  );
  if (config.body === "panel") p.push(`<rect x="34" y="81" width="28" height="13" rx="4" fill="${shade}"/>`);
  if (config.body === "light") p.push(`<circle cx="48" cy="87" r="5" fill="${LIGHT}"/>`);
  if (config.body === "buttons") for (const x of [40, 48, 56]) p.push(`<circle cx="${x}" cy="86" r="2.6" fill="${shade}"/>`);

  const earX = config.head === "round" ? 19 : config.head === "capsule" ? 14 : 16;
  p.push(
    `<rect x="${earX}" y="37" width="8" height="14" rx="3" fill="${shade}"/><rect x="${88 - earX}" y="37" width="8" height="14" rx="3" fill="${shade}"/>`,
  );
  p.push(shape);

  const roundEye = (x: number) => `<circle cx="${x}" cy="42" r="6.5" fill="#ffffff"/><circle cx="${x}" cy="42" r="2.9" fill="${SCREEN}"/>`;
  if (config.eyes === "round") p.push(roundEye(38) + roundEye(58));
  if (config.eyes === "visor")
    p.push(
      `<rect x="28" y="36" width="40" height="13" rx="6.5" fill="${SCREEN}"/><rect x="33" y="40.8" width="30" height="3.6" rx="1.8" fill="${GLOW}"/>`,
    );
  if (config.eyes === "pixel")
    p.push(
      `<rect x="29" y="33" width="38" height="19" rx="6" fill="${SCREEN}"/><rect x="35.5" y="39" width="5.5" height="6.5" rx="1" fill="${GLOW}"/><rect x="55" y="39" width="5.5" height="6.5" rx="1" fill="${GLOW}"/>`,
    );
  if (config.eyes === "cyclops") p.push(`<circle cx="48" cy="42" r="9" fill="#ffffff"/><circle cx="48" cy="42" r="4" fill="${SCREEN}"/>`);
  if (config.eyes === "happy")
    p.push(`<path d="M33 44Q38 38 43 44M53 44Q58 38 63 44" fill="none" stroke="${line}" stroke-width="2.8" stroke-linecap="round"/>`);

  if (config.mouth === "grill")
    p.push(
      `<rect x="38" y="54" width="20" height="7" rx="2.5" fill="${SCREEN}"${line === SCREEN ? "" : ` stroke="${line}" stroke-width="1.2"`}/><path d="M43 55.5V59.5M48 55.5V59.5M53 55.5V59.5" stroke="${body}" stroke-width="1.6" stroke-linecap="round"/>`,
    );
  if (config.mouth === "smile")
    p.push(`<path d="M40 54.5Q48 61.5 56 54.5" fill="none" stroke="${line}" stroke-width="2.8" stroke-linecap="round"/>`);
  if (config.mouth === "led") for (const x of [40.5, 45.5, 50.5, 55.5]) p.push(`<circle cx="${x}" cy="57" r="2" fill="${LIGHT}"/>`);
  if (config.mouth === "line") p.push(`<path d="M41 57H55" stroke="${line}" stroke-width="2.8" stroke-linecap="round"/>`);

  return svg(p, crop === "full" ? AVATAR_CROPS.full : AVATAR_CROPS.robotThumbnail);
}

/** Renders any stored built avatar, whole or as the head crop a picker uses for option thumbnails. */
export const renderAvatarSvg = (config: AvatarConfig, crop: AvatarCrop = "full"): string =>
  config.kind === "person" ? renderPersonAvatar(config, crop) : renderRobotAvatar(config, crop);
