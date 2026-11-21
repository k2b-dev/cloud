import type { CloudResourceRef } from "../contracts/capabilities";
import type { RequestAuthority } from "../server";
import { type AiResourceReaderDependencies, aiResourceKey, nameAiResources } from "./resource-readers";

type Untitled = Record<string, unknown> & CloudResourceRef;

const isUntitledRef = (value: unknown): value is Untitled =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as { type?: unknown }).type === "string" &&
  typeof (value as { id?: unknown }).id === "string" &&
  !(typeof (value as { title?: unknown }).title === "string" && (value as { title: string }).title.trim());

/** Every cell of a table or explorer view and every value of a details view that could be a reference. */
const cellsOf = (view: Record<string, unknown>): { holder: Record<string, unknown>; key: string }[] => {
  const holders: { holder: Record<string, unknown>; key: string }[] = [];
  const rowsOf = (rows: unknown) => (Array.isArray(rows) ? rows : []);
  if (view.view === "table" || view.view === "explorer") {
    const rows = [...rowsOf(view.rows), ...(view.footer && typeof view.footer === "object" ? [view.footer] : [])];
    for (const row of rows)
      if (row && typeof row === "object" && !Array.isArray(row))
        for (const key of Object.keys(row)) holders.push({ holder: row as Record<string, unknown>, key });
  }
  if (view.view === "details")
    for (const item of rowsOf(view.items))
      if (item && typeof item === "object" && !Array.isArray(item)) holders.push({ holder: item as Record<string, unknown>, key: "value" });
  return holders;
};

/**
 * A view file names its references as the reading person may read them, when it is read and never when it is
 * written: a reference Gustav wrote without its title gets the title its own reader returns for this person. One
 * batch per view (`nameAiResources`); a reference the person may not read, or that is gone, keeps no title, and the
 * chat shows "Not available" in its place, without its id and without a link. Nothing is stored.
 */
export async function nameViewReferences(
  bytes: Uint8Array,
  input: { authority: RequestAuthority; locale: string; signal: AbortSignal; dependencies?: AiResourceReaderDependencies },
): Promise<Uint8Array> {
  let view: unknown;
  try {
    view = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return bytes;
  }
  if (!view || typeof view !== "object" || Array.isArray(view)) return bytes;
  const untitled = cellsOf(view as Record<string, unknown>).filter(({ holder, key }) => isUntitledRef(holder[key]));
  if (!untitled.length) return bytes;
  const refs = untitled.map(({ holder, key }) => {
    const ref = holder[key] as Untitled;
    return { type: ref.type, id: ref.id };
  });
  const names = await nameAiResources({ refs, ...input, path: "/api/ai/conversations/files/content" });
  for (const { holder, key } of untitled) {
    const ref = holder[key] as Untitled;
    const name = names.get(aiResourceKey(ref));
    if (name) holder[key] = { ...ref, title: name.title };
  }
  return new TextEncoder().encode(JSON.stringify(view));
}
