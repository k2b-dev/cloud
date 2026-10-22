import { serializeGeoDocument } from "../contracts/geo-document";
import { type AiMap, aiMapWebsite } from "./map-contracts";

/** Each Places result keeps the Notebook contract's 20-pin bound; no pins are dropped from a follow-up map. */
export const aiMapNotebookContent = (map: AiMap): string =>
  [
    `# ${map.title.replace(/[\r\n]/g, " ")}`,
    ...map.groups
      .filter((g) => g.places.length > 0)
      .map((group) =>
        serializeGeoDocument({
          version: 1,
          savedAt: map.viewedAt,
          title: group.title,
          pins: group.places.map((place) => {
            const website = aiMapWebsite(place.website);
            return {
              id: place.id,
              label: place.name,
              point: place.point,
              provenance: place.provenance,
              ...(website ? { link: { type: "url" as const, url: website, label: place.name } } : {}),
            };
          }),
        }),
      ),
    ...(map.route ? [serializeGeoDocument({ version: 1, savedAt: map.viewedAt, title: map.title, pins: [], route: map.route })] : []),
  ].join("\n\n");
