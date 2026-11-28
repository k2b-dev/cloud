import { describe, expect, test } from "bun:test";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { PublicSection } from "../../../contracts";
import "../../ssr-test-plugin";

const { PublicSectionDialog } = await import("./public-sections");

const ownImage = `https://cloud.example.org/public/storage/venue/menu/Cafe01/${"a".repeat(32)}.webp`;
const otherVenueImage = `https://cloud.example.org/public/storage/venue/menu/Bake01/${"b".repeat(32)}.webp`;

const menu = (images: (string | null)[]): PublicSection => ({
  id: "Menu01",
  venueId: "Cafe01",
  kind: "menu",
  title: "Lunch",
  content: { items: images.map((image, index) => ({ name: `Dish ${index + 1}`, image })) },
  enabled: true,
  position: 1,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});

const render = (section: PublicSection, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(PublicSectionDialog, {
          initial: section,
          nextPosition: 1,
          publicPageEnabled: true,
          otherMenuItems: 0,
          venueId: "Cafe01",
          close: () => {},
          submit: async () => null,
        });
      },
    }),
  );

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("Venue menu image notice", () => {
  test("marks an image at another address in place of the image hint, and only there", () => {
    const html = text(render(menu([ownImage, "https://images.example.org/soup.webp", otherVenueImage, null])));
    expect(html.match(/External image – please upload it again/g)).toHaveLength(2);
    expect(html.match(/Optional square image for this menu item\./g)).toHaveLength(2);
  });

  test("says it in German too", () => {
    expect(text(render(menu(["https://images.example.org/soup.webp"]), "de"))).toContain("Externes Bild – bitte neu hochladen");
  });
});
