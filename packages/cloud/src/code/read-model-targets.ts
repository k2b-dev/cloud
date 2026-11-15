import { z } from "zod";
import type { CapabilityClientResult, CapabilityInvocation } from "../capabilities/types";
import { CloudResourceReaderViewSchema, cloudResourceRefAppId } from "../contracts/capabilities";
import { CODE_READ_MODEL_LIST_LIMIT, type CodeVersionReadModel } from "../contracts/code-read-model";

type Invoke = <T extends z.ZodType>(invocation: CapabilityInvocation, schema: T) => Promise<CapabilityClientResult<z.output<T>>>;
const ReaderSchema = z.object({ view: CloudResourceReaderViewSchema });
const keyOf = (ref: { type: string; id: string }) => JSON.stringify([ref.type, ref.id]);

/**
 * Compose Core's grant words with independent canonical reads under the page's viewer credentials. Never pass a
 * child-Query callback here: the owning resource may already have consumed Core's one child Query. Catalog lookup
 * must use that same viewer's authority. Unavailable readers keep Core's type-only text and no link.
 */
export async function nameCodeGrantTargets(
  model: CodeVersionReadModel,
  invoke: Invoke,
  readerOf: (type: string) => string | null | Promise<string | null>,
  signal?: AbortSignal,
): Promise<CodeVersionReadModel> {
  signal?.throwIfAborted();
  const refs = new Map<string, { type: string; id: string }>();
  for (const row of model.mayDo.items.slice(0, CODE_READ_MODEL_LIST_LIMIT)) {
    if (row.target && row.target.text.includes("{name}") && !/[{}]/.test(row.target.text.replace("{name}", "")))
      refs.set(keyOf(row.target.ref), row.target.ref);
  }
  const names = new Map<string, { title: string; href?: string }>();
  const entries = [...refs];
  // Same bounded provider concurrency as the Code page; no promise per target in an unbounded manifest.
  for (let offset = 0; offset < entries.length; offset += 8) {
    signal?.throwIfAborted();
    await Promise.all(
      entries.slice(offset, offset + 8).map(async ([key, ref]) => {
        try {
          signal?.throwIfAborted();
          const reader = await readerOf(ref.type);
          signal?.throwIfAborted();
          if (!reader) return;
          const result = await invoke(
            {
              appId: cloudResourceRefAppId(ref),
              capabilityId: reader,
              kind: "query",
              input: { id: ref.id },
              ...(signal ? { signal } : {}),
            },
            ReaderSchema,
          );
          signal?.throwIfAborted();
          if (!result.ok) return;
          const href = result.data.links?.find((link) => link.rel === "open")?.href;
          names.set(key, { title: result.data.data.view.title, ...(href ? { href } : {}) });
        } catch {
          signal?.throwIfAborted();
          // A failed read never authorizes a name or a link.
        }
      }),
    );
  }
  signal?.throwIfAborted();
  return {
    ...model,
    mayDo: {
      ...model.mayDo,
      items: model.mayDo.items.map((row) => {
        if (!row.target) return row;
        const { href: _unchecked, ...rest } = row;
        const name = refs.has(keyOf(row.target.ref)) ? names.get(keyOf(row.target.ref)) : undefined;
        if (!name || !row.target.text.includes("{name}") || /[{}]/.test(row.target.text.replace("{name}", ""))) return rest;
        return { ...rest, text: row.target.text.replace("{name}", () => name.title), ...(name.href ? { href: name.href } : {}) };
      }),
    },
  };
}
