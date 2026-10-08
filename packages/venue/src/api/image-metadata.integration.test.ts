import { expect, test } from "bun:test";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { z } from "zod";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { tinyJpeg, withCameraMetadata } from "../../../../scripts/fixtures/image-metadata";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { PublicSectionInputSchema, VenueInputSchema } from "../contracts";
import { venueService } from "../service";
import api from ".";

const dataUrl = (bytes: Uint8Array) => `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
const germanMessage = "Dieses Bild konnte nicht gelesen werden. Exportiere es erneut oder wähle eine andere Datei.";

databaseSuite()("Venue content image privacy", () => {
  test("logo, banner and menu images are stripped on create and update, including merged patches; malformed images return 422", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users(uid, provider, profile, display_name, mail)
      VALUES (${`venue-photo-${suffix}`}, 'local', 'user', 'Venue photo', ${`venue-photo-${suffix}@example.test`}) RETURNING id
    `;
    const jpeg = await tinyJpeg();
    const camera = dataUrl(withCameraMetadata(jpeg, 1));
    const clean = dataUrl(jpeg);
    const input = VenueInputSchema.parse({ name: "Photo", slug: `photo-${suffix}`, logoBase64: camera, bannerBase64: camera });
    const created = await venueService.venues.create(input, { id: user!.id });
    if (!created.ok) throw created.error;
    const venue = created.data;
    const call = (method: string, path: string, body: unknown, cookie: string) =>
      api.request(path, {
        method,
        headers: { cookie, "content-type": "application/json", "accept-language": "de", "x-forwarded-for": uniqueCallerAddress() },
        body: JSON.stringify(body),
      });
    try {
      const cookie = `session_token=${await createTestSession(user!.id)}`;
      const [ids] = await sql<{ short_id: string }[]>`SELECT short_id FROM venue.venues WHERE id=${venue.id}::uuid`;
      const path = `/venues/${ids!.short_id}`;
      const checkVenue = async () => {
        const [stored] = await sql<
          { logo_base64: string; banner_base64: string }[]
        >`SELECT logo_base64, banner_base64 FROM venue.venues WHERE id=${venue.id}::uuid`;
        expect(stored).toMatchObject({ logo_base64: clean, banner_base64: clean });
      };
      await checkVenue();
      expect((await call("PATCH", path, input, cookie)).status).toBe(200);
      await checkVenue();
      const sectionInput = PublicSectionInputSchema.parse({
        kind: "menu",
        title: "Menu",
        content: { items: [{ name: "Coffee", image: camera }] },
      });
      const section = await venueService.sections.create(venue.id, sectionInput);
      if (!section.ok) throw section.error;
      const [sectionIds] = await sql<{ short_id: string }[]>`SELECT short_id FROM venue.public_sections WHERE id=${section.data.id}::uuid`;
      const sectionPath = `${path}/sections/${sectionIds!.short_id}`;
      const checkSection = async () => {
        const [stored] = await sql<{ content: unknown }[]>`SELECT content FROM venue.public_sections WHERE id=${section.data.id}::uuid`;
        expect(stored?.content).toMatchObject({ items: [{ name: "Coffee", image: clean }] });
      };
      await checkSection();
      expect((await call("PATCH", sectionPath, { content: sectionInput.content }, cookie)).status).toBe(200);
      await checkSection();
      // An omitted content patch sanitizes legacy images in the merged stored content too.
      await sql`UPDATE venue.public_sections SET content=${JSON.stringify(sectionInput.content)}::text::jsonb WHERE id=${section.data.id}::uuid`;
      expect((await call("PATCH", sectionPath, { title: "New menu" }, cookie)).status).toBe(200);
      await checkSection();
      const apiCreated = await call("POST", `${path}/sections`, sectionInput, cookie);
      expect(apiCreated.status).toBe(201);
      expect(z.object({ content: z.unknown() }).parse(await apiCreated.json()).content).toMatchObject({
        items: [{ name: "Coffee", image: clean }],
      });
      const malformed = dataUrl(new Uint8Array([255, 216, 255, 219, 0]));
      for (const [method, url, body] of [
        ["POST", "/venues", { ...input, slug: `${input.slug}-invalid`, logoBase64: malformed }],
        ["PATCH", path, { ...input, bannerBase64: malformed }],
        ["POST", `${path}/sections`, { ...sectionInput, content: { items: [{ name: "Coffee", image: malformed }] } }],
        ["PATCH", sectionPath, { content: { items: [{ name: "Coffee", image: malformed }] } }],
      ] as const) {
        const response = await call(method, url, body, cookie);
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ code: "MALFORMED_IMAGE", message: germanMessage });
      }
      await checkVenue();
      await checkSection();
    } finally {
      await sql`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM venue.venue_access WHERE venue_id=${venue.id}::uuid)`;
      await sql`DELETE FROM venue.venues WHERE id=${venue.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
    }
  });
});
