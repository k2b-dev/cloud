// Photos for the photo editor's browser harness: real JPEGs (the Venue app's café templates) opened the way the
// editor opens a dropped file, with invented camera names. Browser only.
import { images as imageTools } from "@k2b/stdlib/browser";
import { DEFAULT_ADJ } from "./constants";
import { makePreviewSource, makeThumbnail } from "./image-processing";
import { FULL_CROP_BOUNDS } from "./markup";
import type { ImageEntry } from "./types";

/** The photos the harness serves under `/photos/<file>`, and the names they carry in the editor. */
export const FIXTURE_PHOTOS = [
  { file: "cafe-espresso.jpg", name: "IMG_20261121_0912_Espresso.jpg" },
  { file: "cafe-cappuccino.jpg", name: "IMG_20261121_0915_Cappuccino.jpg" },
  { file: "cafe-avocado-toast.jpg", name: "IMG_20261121_0931_Fruehstueck.jpg" },
  // the worst case: a long name without a break, as exports from print shops come
  { file: "cafe-banner.jpg", name: "Cafe-Banner_Herbstkarte_2026_final_final_v3_freigegeben_Druckerei-Mueller_CMYK_300dpi.jpg" },
] as const;

/** `reverse` opens the worst case first. */
export const openFixturePhotos = async (count: number = FIXTURE_PHOTOS.length, reverse = false): Promise<ImageEntry[]> =>
  Promise.all(
    (reverse ? [...FIXTURE_PHOTOS].reverse() : [...FIXTURE_PHOTOS]).slice(0, count).map(async (photo, index) => {
      const blob = await (await fetch(`/photos/${photo.file}`)).blob();
      const file = new File([blob], photo.name, { type: "image/jpeg" });
      const source = await imageTools.create(blob);
      const previewSource = await makePreviewSource(source);
      const thumbUrl = await makeThumbnail(previewSource);
      return {
        id: `fixture-photo-${index}`,
        file,
        source,
        previewSource,
        originalSource: source,
        originalPreviewSource: previewSource,
        thumbUrl,
        name: photo.name,
        // the first photo carries a look, so the stage and its preset show one
        adj:
          index === 0
            ? { ...DEFAULT_ADJ, brightness: 1.05, contrast: 1.05, saturation: 1.1, hueRotate: 15, sepia: 0.15 }
            : { ...DEFAULT_ADJ },
        markup: [],
        markupUndo: [],
        markupRedo: [],
        cropped: false,
        cropBounds: { ...FULL_CROP_BOUNDS },
      };
    }),
  );
