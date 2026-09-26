import { type CloudCliContext, type CloudCliText, cliAmbiguityText, cliText, parseCliAddress } from "@k2b/cloud/cli";
import type { ApiType } from "./api";
import type { BaseSummary, BasesResult, EntryResult } from "./contracts";
import { parseEntryRefId } from "./resource-ref";

/**
 * `cld filesv2` addresses. A file argument is `<area>:/path` or a file ID; an
 * area is `me` (the personal area), a group area's ID or exact name, or a
 * full area ID such as `cloud:groups:<uuid>`. Parsing never contacts the
 * server; the resolver matches areas against `GET /bases` and never guesses.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** Area IDs contain colons, so they are matched before the generic `<container>:<path>` split. */
const AREA_ID = new RegExp(`^((?:cloud|freeipa):(?:users|groups):${UUID})(?::(.*))?$`, "i");
/** Long paths get a durable server-side ID instead of an inline one. */
const PERSISTED_FILE_ID = /^p:[a-f0-9]{64}$/;
const ADMIN_DIRECTORY = /^(cloud|freeipa)\/(users|groups|archive)\/([^:/]+)(?::(.*))?$/;

export type AreaRef = { kind: "id"; id: string } | { kind: "me" } | { kind: "ref"; value: string };

export type FileAddress =
  | { kind: "file-id"; id: string }
  /** `folder`: a trailing slash or the area root, so the address names a folder to put entries into. */
  | { kind: "path"; area: AreaRef; container: string; path: string; folder: boolean };

/** A resolved file argument: the area ID and the path inside it (`""` is the area root). */
export type FileTarget = { baseId: string; path: string; folder: boolean };

export class CliAddressError extends Error {
  constructor(readonly text: CloudCliText) {
    super(text.en);
  }
}

const areaRef = (container: string): AreaRef =>
  AREA_ID.test(container) ? { kind: "id", id: container } : container === "me" ? { kind: "me" } : { kind: "ref", value: container };

const normalizePath = (raw: string) => ({
  path: raw.replace(/^\/+/, "").replace(/\/+$/, ""),
  folder: raw.replace(/^\/+/, "") === "" || raw.endsWith("/"),
});

export function parseFileAddress(raw: string): FileAddress {
  const id = AREA_ID.exec(raw);
  if (id) return { kind: "path", area: { kind: "id", id: id[1]! }, container: id[1]!, ...normalizePath(id[2] ?? "") };
  if (PERSISTED_FILE_ID.test(raw)) return { kind: "file-id", id: raw };
  const address = parseCliAddress(raw);
  if (address.kind === "local")
    throw new CliAddressError({
      en: `"${raw}" is a local path. Address Cloud files as <area>:/path or by file ID.`,
      de: `„${raw}“ ist ein lokaler Pfad. Adressiere Cloud-Dateien als <bereich>:/pfad oder per Datei-ID.`,
    });
  if (address.kind === "path")
    return { kind: "path", area: areaRef(address.container), container: address.container, ...normalizePath(address.path) };
  if (!parseEntryRefId(address.ref))
    throw new CliAddressError({
      en: `"${raw}" is not a file ID. Address an area as "${raw}:" and a file as "${raw}:/path".`,
      de: `„${raw}“ ist keine Datei-ID. Adressiere einen Bereich als „${raw}:“ und eine Datei als „${raw}:/pfad“.`,
    });
  return { kind: "file-id", id: address.ref };
}

/** An area alone: `me`, `me:`, `me:/`, a group name or ID, or an area ID. */
export function parseAreaAddress(raw: string): AreaRef {
  const area = raw.replace(/:\/*$/, "");
  if (!area || (area.includes(":") && !AREA_ID.test(area)))
    throw new CliAddressError({
      en: `"${raw}" is not an area. Use me, a group name or an area ID from "ls".`,
      de: `„${raw}“ ist kein Bereich. Verwende me, einen Gruppennamen oder eine Bereichs-ID aus „ls“.`,
    });
  return areaRef(area);
}

/** The area part of an address as the CLI shows it: `me` for the personal area, the group name otherwise. */
export const areaLabel = (base: { kind?: BaseSummary["kind"]; name: string }) => (base.kind === "users" ? "me" : base.name);

/** An entry's address as the CLI prints it. */
export const addressOf = (base: { kind?: BaseSummary["kind"]; name: string }, path: string) => `${areaLabel(base)}:/${path}`;

/** `me` matches the personal areas; any other value an area ID, a group ID or an exact group name. */
export function matchAreas(bases: readonly BaseSummary[], ref: AreaRef): BaseSummary[] {
  if (ref.kind === "me") return bases.filter((base) => base.kind === "users");
  if (ref.kind === "id") return bases.filter((base) => base.id.toLowerCase() === ref.id.toLowerCase());
  return bases.filter(
    (base) => base.id === ref.value || base.id.endsWith(`:${ref.value}`) || (base.kind === "groups" && base.name === ref.value),
  );
}

/** Exactly one area ID, or an error listing every candidate. A full area ID passes unchanged, even for a hidden area. */
export function pickArea(bases: readonly BaseSummary[], ref: AreaRef, raw: string): string {
  if (ref.kind === "id") return ref.id;
  const matches = matchAreas(bases, ref);
  if (matches.length === 1) return matches[0]!.id;
  if (!matches.length)
    throw new CliAddressError(
      ref.kind === "me"
        ? { en: "404 You have no personal area.", de: "404 Du hast keinen persönlichen Bereich." }
        : {
            en: `404 No area matches "${raw}". "ls" lists your areas.`,
            de: `404 Kein Bereich passt zu „${raw}“. „ls“ zeigt deine Bereiche.`,
          },
    );
  const text = cliAmbiguityText({
    value: raw,
    resources: { en: "areas", de: "Bereichen" },
    candidates: matches.map((base) => ({ path: `${base.area}/${base.kind}/${base.name}`, id: base.id })),
  });
  throw new CliAddressError({ en: `409 ${text.en}`, de: `409 ${text.de}` });
}

export type AdminLocator =
  | { area: "cloud" | "freeipa"; kind: "users" | "groups"; name: string }
  | { area: "cloud" | "freeipa"; archiveId: string };

/** `<storage>/<users|groups>/<name>` or `<storage>/archive/<archive-id>`, optionally followed by `:/path`. */
export function parseAdminAddress(raw: string): { locator: AdminLocator; path: string } {
  const match = ADMIN_DIRECTORY.exec(raw);
  if (!match)
    throw new CliAddressError({
      en: `"${raw}" is not a directory address. Use <cloud|freeipa>/<users|groups>/<name> or <cloud|freeipa>/archive/<archive-id>, optionally followed by :/path.`,
      de: `„${raw}“ ist keine Verzeichnisadresse. Verwende <cloud|freeipa>/<users|groups>/<name> oder <cloud|freeipa>/archive/<archiv-id>, optional gefolgt von :/pfad.`,
    });
  const [, area, kind, name, path] = match as unknown as [string, "cloud" | "freeipa", "users" | "groups" | "archive", string, string?];
  return {
    locator: kind === "archive" ? { area, archiveId: name } : { area, kind, name },
    path: normalizePath(path ?? "").path,
  };
}

/** Resolves file and area arguments for one command run; the area list is fetched at most once. */
export function fileResolver(ctx: CloudCliContext) {
  const api = ctx.createApiClient<ApiType>("/api/filesv2");
  const localized = <T>(run: () => T): T => {
    try {
      return run();
    } catch (error) {
      if (error instanceof CliAddressError) throw new Error(cliText(ctx, error.text));
      throw error;
    }
  };
  let bases: Promise<BaseSummary[]> | undefined;
  const areas = () => {
    bases ??= api.bases.$get().then(async (response) => (await ctx.readJson<BasesResult>(response)).items);
    return bases;
  };
  const areaId = async (ref: AreaRef, raw: string) => {
    if (ref.kind === "id") return ref.id;
    const list = await areas();
    return localized(() => pickArea(list, ref, raw));
  };
  const file = async (raw: string): Promise<FileTarget & { entry?: EntryResult }> => {
    const address = localized(() => parseFileAddress(raw));
    if (address.kind === "file-id") {
      const entry = await ctx.readJson<EntryResult>(await api.entries[":id"].$get({ param: { id: address.id } }));
      return { baseId: entry.base.id, path: entry.entry.path, folder: entry.entry.directory, entry };
    }
    return { baseId: await areaId(address.area, address.container), path: address.path, folder: address.folder };
  };
  return {
    async area(raw: string): Promise<string> {
      return areaId(
        localized(() => parseAreaAddress(raw)),
        raw.replace(/:\/*$/, ""),
      );
    },
    file,
    /** Several file arguments that must share one area, as every batch API works inside one area. */
    async sameArea(raws: readonly string[]): Promise<{ baseId: string; targets: FileTarget[] }> {
      const targets: FileTarget[] = [];
      for (const raw of raws) targets.push(await file(raw));
      const baseId = targets[0]?.baseId;
      if (!baseId) throw new Error(cliText(ctx, { en: "Pass at least one file address.", de: "Gib mindestens eine Dateiadresse an." }));
      if (targets.some((target) => target.baseId !== baseId))
        throw new Error(
          cliText(ctx, { en: "All addresses must be in the same area.", de: "Alle Adressen müssen im selben Bereich liegen." }),
        );
      return { baseId, targets };
    },
  };
}
