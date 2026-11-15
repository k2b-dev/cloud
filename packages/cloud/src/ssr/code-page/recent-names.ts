import { z } from "zod";
import { CloudResourceReaderViewSchema, cloudResourceRefAppId } from "../../contracts/capabilities";
import type { CodeActivityReadModel } from "../../contracts/code-read-model";
import type { CodePageInvoke } from "./data";

type Recent = CodeActivityReadModel["recent"][number];

/** Core lists at most six recent results; the page reads at most this many targets for them. */
export const CODE_RECENT_NAME_READS = 6;

/** A resource type's canonical reader Query, by local ID; null when the type has none. */
export type CodeRecentReaderOf = (type: string) => string | null | Promise<string | null>;

const ReaderSchema = z.object({ view: CloudResourceReaderViewSchema });
const refKey = (ref: { type: string; id: string }) => JSON.stringify([ref.type, ref.id]);

/**
 * Core names a recent result only by its kind and hands over the target's reference. The page asks the target's own
 * reader, one call per target and with the reading person's rights. Only a title the reader returns fills `{name}`, as
 * plain text, and only its `open` link becomes a link; a refusal, a missing reader or a failure keeps Core's sentence
 * without a name or link. A reference itself is never shown.
 */
export async function nameRecentResults(
  recent: readonly Recent[],
  invoke: CodePageInvoke,
  readerOf: CodeRecentReaderOf,
): Promise<Recent[]> {
  const refs = new Map<string, { type: string; id: string }>();
  for (const item of recent) if (item.target && refs.size < CODE_RECENT_NAME_READS) refs.set(refKey(item.target.ref), item.target.ref);
  const named = new Map<string, { title: string; href?: string }>();
  await Promise.all(
    [...refs].map(async ([key, ref]) => {
      try {
        const reader = await readerOf(ref.type);
        if (!reader) return;
        const result = await invoke(
          { appId: cloudResourceRefAppId(ref), capabilityId: reader, kind: "query", input: { id: ref.id } },
          ReaderSchema,
        );
        if (!result.ok) return;
        const href = result.data.links?.find((link) => link.rel === "open")?.href;
        named.set(key, { title: result.data.data.view.title, ...(href ? { href } : {}) });
      } catch {
        // A reader that cannot answer leaves the sentence without a name.
      }
    }),
  );
  return recent.map((item) => {
    const name = item.target ? named.get(refKey(item.target.ref)) : undefined;
    const { href: _unchecked, ...rest } = item;
    if (!item.target || !name) return rest;
    return { ...rest, text: item.target.text.replace("{name}", () => name.title), ...(name.href ? { href: name.href } : {}) };
  });
}

/** The same result before and after its name is read, so a later read of the list never adds it twice. */
export const recentResultKey = (item: Pick<Recent, "runId" | "text" | "target">) =>
  item.target ? `${item.runId}:${refKey(item.target.ref)}:${item.target.text}` : `${item.runId}:${item.text}`;
