import { z } from "zod";
export type SecretPerson = { id: string; name: string };
export type CodePeopleViewer = { id: string | null; directory: boolean };
export const visiblePersonIds = (ids: Iterable<string | null | undefined>, viewer: CodePeopleViewer): string[] =>
  [
    ...new Set(
      [...ids].filter(
        (id): id is string => typeof id === "string" && z.uuid().safeParse(id).success && (viewer.directory || id === viewer.id),
      ),
    ),
  ].slice(0, 100);
export const codePersonName = (row: { display_name: string | null; given_name: string | null; sn: string | null; uid: string }): string =>
  row.display_name?.trim() || `${row.given_name ?? ""} ${row.sn ?? ""}`.trim() || row.uid;
/** Unknown/deleted/hidden people never fall back to a UUID in the card. */
export const secretSetter = (id: string | null, people: ReadonlyMap<string, SecretPerson>): SecretPerson | null =>
  id ? (people.get(id) ?? null) : null;
