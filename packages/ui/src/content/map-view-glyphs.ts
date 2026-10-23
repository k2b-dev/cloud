import { PbfReader } from "pbf";

type Glyph = { id?: number; bitmap?: Uint8Array; width?: number; height?: number; left?: number; top?: number; advance?: number };
const readGlyph = (tag: number, glyph: Glyph, pbf: PbfReader) => {
  if (tag === 1) glyph.id = pbf.readVarint();
  else if (tag === 2) glyph.bitmap = pbf.readBytes();
  else if (tag === 3) glyph.width = pbf.readVarint();
  else if (tag === 4) glyph.height = pbf.readVarint();
  else if (tag === 5) glyph.left = pbf.readSVarint();
  else if (tag === 6) glyph.top = pbf.readSVarint();
  else if (tag === 7) glyph.advance = pbf.readVarint();
};

/**
 * Validate the glyphs MapLibre will decode before it can silently substitute local fonts.
 * Uses the same PBF reader and 3px bitmap border as MapLibre 6, without allocating glyph images.
 */
export function validateMapGlyphs(data: ArrayBuffer): void {
  let count = 0;
  new PbfReader(data).readFields((tag, _unused, pbf) => {
    if (tag !== 1) return;
    pbf.readMessage((tag, _unused, pbf) => {
      if (tag !== 3) return;
      const glyph = pbf.readMessage<Glyph>(readGlyph, {});
      if (
        glyph.id === undefined ||
        !Number.isInteger(glyph.id) ||
        glyph.id < 0 ||
        glyph.id > 0x10ffff ||
        glyph.width === undefined ||
        glyph.height === undefined ||
        glyph.left === undefined ||
        glyph.top === undefined ||
        glyph.advance === undefined ||
        (!glyph.bitmap && (glyph.width !== 0 || glyph.height !== 0)) ||
        (glyph.bitmap !== undefined && glyph.bitmap.byteLength !== (glyph.width + 6) * (glyph.height + 6))
      )
        throw new Error("Invalid map glyph data");
      count++;
    }, null);
  }, null);
  if (!count) throw new Error("Missing map glyph data");
}
