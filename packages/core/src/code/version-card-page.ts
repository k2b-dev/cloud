import { CAPABILITY_MAX_RESULT_BYTES } from "@k2b/cloud/contracts";
import type { CodeVersionCards } from "@k2b/cloud/contracts/code-version-cards";

type Ref = { codeId: string; versionId: string };
const key = (ref: Ref) => `${ref.codeId}:${ref.versionId}`;

/** Reserve all possible continuation refs plus both provider and dispatcher envelopes under the 256 KiB contract. */
export function fillCodeVersionCardPage(requested: readonly Ref[], candidates: CodeVersionCards["items"]): CodeVersionCards {
  const reserved = Buffer.byteLength(JSON.stringify({ version: 1, data: { data: { items: [], remaining: requested } } }));
  const budget = CAPABILITY_MAX_RESULT_BYTES - reserved;
  const available = new Map(candidates.map((item) => [key(item), item]));
  const items: CodeVersionCards["items"] = [];
  const remaining: Ref[] = [];
  let used = 0;
  for (const ref of requested) {
    let item = available.get(key(ref));
    if (!item) {
      remaining.push(ref);
      continue;
    }
    let bytes = Buffer.byteLength(JSON.stringify(item));
    // One unreturnable card is an explicit read failure, never an endless same-input continuation.
    if (bytes > budget) {
      item = { ...ref, state: "failed" };
      bytes = Buffer.byteLength(JSON.stringify(item));
    }
    const separator = items.length ? 1 : 0;
    if (used + separator + bytes > budget) remaining.push(ref);
    else {
      items.push(item);
      used += separator + bytes;
    }
  }
  return { items, remaining };
}
