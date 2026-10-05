import type { LiveViewer } from "@k2b/cloud/events";
import { sql } from "bun";
import { z } from "zod";
import { ShortIdSchema } from "../contracts";
import { gridsLiveKey } from "../service/live";
import { type PublicResourceType, resolvePublicId } from "../service/public-resources";
import { gateBaseAtAccess } from "./permissions";

/** The Base whose readers may follow `key`, or `null` once it or the table or workflow it names is deleted. */
const baseOfKey = async (key: string): Promise<string | null> => {
  const separator = key.indexOf(":");
  const kind = key.slice(0, separator);
  const id = key.slice(separator + 1);
  const rows =
    kind === "base"
      ? await sql<{ base_id: string }[]>`SELECT id::text AS base_id FROM grids.bases WHERE id = ${id}::uuid AND deleted_at IS NULL`
      : kind === "table"
        ? await sql<{ base_id: string }[]>`
            SELECT t.base_id::text AS base_id FROM grids.tables t
            JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
            WHERE t.id = ${id}::uuid AND t.deleted_at IS NULL`
        : kind === "workflow"
          ? await sql<{ base_id: string }[]>`
              SELECT p.base_id::text AS base_id FROM grids.workflow_profile p
              JOIN grids.bases b ON b.id = p.base_id AND b.deleted_at IS NULL
              WHERE p.id = ${id}::uuid AND p.deleted_at IS NULL`
          : [];
  return rows[0]?.base_id ?? null;
};

/** Readers of a Base follow its tables, structure, and workflow runs: the Grids API's own read decision, per viewer. */
const authorize = async (key: string, viewers: readonly LiveViewer[]): Promise<ReadonlySet<string>> => {
  const baseId = await baseOfKey(key);
  if (!baseId) return new Set();
  const decisions = await Promise.all(
    viewers.map((viewer) => gateBaseAtAccess({ actor: viewer.actor, accessSubject: viewer.accessSubject }, baseId, "read")),
  );
  return new Set(viewers.filter((_, position) => decisions[position]?.ok).map((viewer) => viewer.id));
};

const keysOf = async (resource: PublicResourceType, publicId: string, key: (id: string) => string) => {
  const id = await resolvePublicId(resource, publicId);
  return id ? [key(id)] : null;
};

/** `records` follows one table, `metadata` one Base's structure and access, `runs` one workflow's runs. */
export const gridsLiveChannels = {
  records: {
    scope: z.object({ table: ShortIdSchema }).strict(),
    keys: ({ table }: { table: string }) => keysOf("table", table, gridsLiveKey.table),
    authorize,
  },
  metadata: {
    scope: z.object({ base: ShortIdSchema }).strict(),
    keys: ({ base }: { base: string }) => keysOf("base", base, gridsLiveKey.base),
    authorize,
  },
  runs: {
    scope: z.object({ workflow: ShortIdSchema }).strict(),
    keys: ({ workflow }: { workflow: string }) => keysOf("workflow", workflow, gridsLiveKey.workflow),
    authorize,
  },
};
