import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kiosk } from "../src/_internal/installable.test-fixture";
import { INSTALLABLE_ICON_VARIANTS } from "../src/_internal/installable-assets";
import { writeInstallableIcons } from "./installable-assets";

describe("installable raster asset build", () => {
  test("isolated renderer emits both themes at launcher and Apple dimensions with a maskable safe zone", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-installable-icons-"));
    try {
      await writeInstallableIcons(root, "inventory", kiosk);
      const out = join(root, "inventory", "installable");
      expect(await readdir(out)).toHaveLength(8);
      for (const theme of ["light", "dark"])
        for (const [id, variant] of Object.entries(INSTALLABLE_ICON_VARIANTS)) {
          const png = await readFile(join(out, `${id}-${theme}.png`));
          expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
          expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([variant.size, variant.size]);
        }
      expect(await readFile(join(out, "icon-512-dark.png"))).not.toEqual(await readFile(join(out, "icon-512-light.png")));
      // The farthest corner of the fitted square remains within the maskable safe circle.
      expect(INSTALLABLE_ICON_VARIANTS["icon-maskable-512"].box / Math.sqrt(2)).toBeLessThanOrEqual(0.4);
      await expect(writeInstallableIcons(root, "inventory", { ...kiosk, icon: "ti ti-no-such-tabler-icon-xyz" })).rejects.toThrow(
        "Unknown Tabler app icon",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
