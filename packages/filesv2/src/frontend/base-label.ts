import { groupDisplayName } from "@k2b/cloud/shared";
import type { BaseKind } from "../contracts";

/**
 * Presentation name of a storage location. `name` stays the technical name used by the API and CLI;
 * the personal base reads "Personal" so it is not mistaken for a group of the same name, and a group
 * area uses the locale's group display name.
 */
export const baseLabel = (
  base: { name: string; kind?: BaseKind; owner?: { name: string; kind: "standalone" | "agent" } },
  messages: { personal: string },
  locale: string,
) => (base.owner ? base.owner.name : base.kind === "users" ? messages.personal : groupDisplayName(base.name, locale));
