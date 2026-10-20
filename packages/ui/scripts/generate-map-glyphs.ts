import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const fontstack = "IBM Plex Sans Medium";
const subsets = ["latin", "latin-ext", "vietnamese", "greek", "cyrillic", "cyrillic-ext"] as const;
const defaultOut = resolve(import.meta.dir, "../map-glyphs");
// Unshipped ranges fall back to the browser's local font; shipped partial ranges drop the letters they lack.
export const skippedRangeStarts = [1280, 65024, 65280];

type Fontnik = {
  load(font: Buffer, callback: (error: Error | null, faces: { points: number[] }[]) => void): void;
  range(options: { font: Buffer; start: number; end: number }, callback: (error: Error | null, pbf: Buffer) => void): void;
};
type Field = { id: number; value: number | Uint8Array };
type Glyph = { id: number; bitmap?: Uint8Array; width?: number; height?: number; left?: number; top?: number; advance?: number };

// Only varint and length-delimited fields occur in the glyph schema.
class Reader {
  private position = 0;
  constructor(private bytes: Uint8Array) {}

  private varint(): number {
    let value = 0;
    for (let shift = 0; shift < 49; shift += 7) {
      const byte = this.bytes[this.position++];
      if (byte === undefined) throw new Error("Truncated glyph varint");
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) return value;
    }
    throw new Error("Oversized glyph varint");
  }

  *fields(): Generator<Field> {
    while (this.position < this.bytes.length) {
      const tag = this.varint();
      const id = Math.floor(tag / 8);
      const wire = tag % 8;
      if (id === 0) throw new Error("Invalid glyph field");
      if (wire === 0) yield { id, value: this.varint() };
      else if (wire === 2) {
        const length = this.varint();
        const end = this.position + length;
        if (end > this.bytes.length) throw new Error("Truncated glyph field");
        const value = this.bytes.subarray(this.position, end);
        this.position = end;
        yield { id, value };
      } else throw new Error(`Unsupported glyph wire type: ${wire}`);
    }
  }
}

class Writer {
  private bytes: number[] = [];

  private varint(value: number): void {
    do {
      const byte = value % 128;
      value = Math.floor(value / 128);
      this.bytes.push(byte + (value > 0 ? 128 : 0));
    } while (value > 0);
  }

  uint(id: number, value: number | undefined): void {
    if (value === undefined) return;
    this.varint(id * 8);
    this.varint(value);
  }

  sint(id: number, value: number | undefined): void {
    this.uint(id, value === undefined ? undefined : value < 0 ? -2 * value - 1 : 2 * value);
  }

  data(id: number, value: Uint8Array | undefined): void {
    if (value === undefined) return;
    this.varint(id * 8 + 2);
    this.varint(value.length);
    for (const byte of value) this.bytes.push(byte);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

const decodeGlyph = (bytes: Uint8Array): Glyph => {
  const glyph: Partial<Glyph> = {};
  for (const { id, value } of new Reader(bytes).fields()) {
    if (id === 2 && value instanceof Uint8Array) glyph.bitmap = value;
    else if (typeof value === "number") {
      switch (id) {
        case 1:
          glyph.id = value;
          break;
        case 3:
          glyph.width = value;
          break;
        case 4:
          glyph.height = value;
          break;
        case 5:
          glyph.left = value % 2 ? -(value + 1) / 2 : value / 2;
          break;
        case 6:
          glyph.top = value % 2 ? -(value + 1) / 2 : value / 2;
          break;
        case 7:
          glyph.advance = value;
          break;
      }
    }
  }
  if (glyph.id === undefined) throw new Error("Glyph is missing its codepoint");
  return { ...glyph, id: glyph.id };
};

const decodeGlyphs = (bytes: Uint8Array): Glyph[] => {
  const glyphs: Glyph[] = [];
  for (const stack of new Reader(bytes).fields()) {
    if (stack.id !== 1 || !(stack.value instanceof Uint8Array)) continue;
    for (const field of new Reader(stack.value).fields()) {
      if (field.id === 3 && field.value instanceof Uint8Array) glyphs.push(decodeGlyph(field.value));
    }
  }
  return glyphs;
};

const encodeGlyphs = (range: string, glyphs: Glyph[]): Uint8Array => {
  const stack = new Writer();
  const encoder = new TextEncoder();
  stack.data(1, encoder.encode(fontstack));
  stack.data(2, encoder.encode(range));
  for (const glyph of glyphs) {
    const message = new Writer();
    message.uint(1, glyph.id);
    message.data(2, glyph.bitmap);
    message.uint(3, glyph.width);
    message.uint(4, glyph.height);
    message.sint(5, glyph.left);
    message.sint(6, glyph.top);
    message.uint(7, glyph.advance);
    stack.data(3, message.finish());
  }
  const message = new Writer();
  message.data(1, stack.finish());
  return message.finish();
};

const pinnedPackage = async (name: string, version: string): Promise<string> => {
  const path = require.resolve(`${name}/package.json`);
  const manifest = await Bun.file(path).json();
  if (manifest.version !== version) {
    throw new Error(`Map glyph generation requires ${name}@${version}; resolved ${manifest.version}`);
  }
  return dirname(path);
};

/** Generate the pinned fontstack, returning totals for all shipped files, including OFL.txt. */
export async function generateMapGlyphs(outDir = defaultOut) {
  await pinnedPackage("fontnik", "0.7.7");
  const fontRoot = await pinnedPackage("@fontsource/ibm-plex-sans", "5.3.0");
  // fontnik loads its shipped platform prebuild directly; no install script is needed.
  const fontnik: Fontnik = require("fontnik");
  const fonts: { font: Buffer; ranges: Set<number> }[] = [];
  for (const subset of subsets) {
    const font = await readFile(join(fontRoot, "files", `ibm-plex-sans-${subset}-500-normal.woff`));
    const faces = await new Promise<{ points: number[] }[]>((resolve, reject) => {
      fontnik.load(font, (error, faces) => (error ? reject(error) : resolve(faces)));
    });
    if (!faces[0]) throw new Error(`No font face in ${subset}`);
    fonts.push({ font, ranges: new Set(faces[0].points.map((point) => Math.floor(point / 256) * 256)) });
  }
  const starts = [...new Set(fonts.flatMap(({ ranges }) => [...ranges]))]
    .filter((start) => !skippedRangeStarts.includes(start))
    .sort((a, b) => a - b);
  const directory = join(outDir, fontstack);
  await mkdir(directory, { recursive: true });
  for (const file of (await readdir(directory)).sort()) {
    if (file.endsWith(".pbf")) await rm(join(directory, file));
  }
  let rawBytes = 0;
  let gzipBytes = 0;
  for (const start of starts) {
    const end = start + 255;
    const merged = new Map<number, Glyph>();
    for (const { font, ranges } of fonts) {
      if (!ranges.has(start)) continue;
      const pbf = await new Promise<Buffer>((resolve, reject) => {
        fontnik.range({ font, start, end }, (error, pbf) => (error ? reject(error) : resolve(pbf)));
      });
      for (const glyph of decodeGlyphs(pbf)) {
        if (!merged.has(glyph.id)) merged.set(glyph.id, glyph);
      }
    }
    const range = `${start}-${end}`;
    const bytes = encodeGlyphs(
      range,
      [...merged.values()].sort((a, b) => a.id - b.id),
    );
    await writeFile(join(directory, `${range}.pbf`), bytes);
    rawBytes += bytes.length;
    gzipBytes += gzipSync(bytes, { level: 6 }).length;
  }
  await copyFile(join(fontRoot, "LICENSE"), join(outDir, "OFL.txt"));
  const license = await readFile(join(outDir, "OFL.txt"));
  rawBytes += license.length;
  gzipBytes += gzipSync(license, { level: 6 }).length;
  return { fileCount: starts.length + 1, rawBytes, gzipBytes };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Usage: bun packages/ui/scripts/generate-map-glyphs.ts [--out <dir>]\nDefault output: packages/ui/map-glyphs\nCommitted assets are generated on linux-x64.",
    );
  } else if (args.length === 0 || (args.length === 2 && args[0] === "--out" && args[1] && !args[1].startsWith("--"))) {
    try {
      const sizes = await generateMapGlyphs(args[1] ? resolve(args[1]) : defaultOut);
      console.log(
        `${sizes.fileCount} files; ${sizes.rawBytes} raw bytes (${(sizes.rawBytes / 1024).toFixed(1)} KiB); ${sizes.gzipBytes} gzip bytes (${(sizes.gzipBytes / 1024).toFixed(1)} KiB, level 6)`,
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  } else {
    console.error("Usage: bun packages/ui/scripts/generate-map-glyphs.ts [--out <dir>]");
    process.exitCode = 1;
  }
}
