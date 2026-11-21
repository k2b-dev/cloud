import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { CloudResourceReaderViewSchema } from "@k2b/cloud/contracts";
import { z } from "zod";

/** A fictional resource provider with the complete Code owner contract. */
export function codeOwnerCatalogFixture(appId: string, localType: string) {
  const reader = `${localType}.read`;
  return {
    appId,
    appName: "Fixture",
    appIcon: "ti ti-box",
    appDescription: "Fixture owner provider",
    manifest: compileCapabilityManifest(appId, {
      protocolVersion: 2,
      types: { [localType]: { title: "Item", description: "Fixture item.", reader } },
      code: { owners: [localType] },
      queries: {
        [reader]: {
          title: "Read item",
          description: "Read the fixture item.",
          openWorld: false,
          codeResourceTitle: () => "Item",
          input: z.object({ id: z.string().min(1).max(512).describe("Item ID.") }).strict(),
          data: z.object({ view: CloudResourceReaderViewSchema }),
          run: () => ({ ok: true as const, data: { data: { view: { title: "Item", permission: "admin" as const } } } }),
        },
      },
    }),
  };
}
