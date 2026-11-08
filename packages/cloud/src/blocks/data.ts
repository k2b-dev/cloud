import { CAPABILITY_MAX_RESULT_BYTES } from "../contracts/capability-limits";
import { BLOCK_LIMITS } from "./schema";

export const unsafeBlockKey = (key: string): boolean => ["__proto__", "constructor", "prototype"].includes(key);

/** Guard before schemas, binding or serialization. Traversal stops as soon as the budget is exhausted. */
export function assertBlockData(value: unknown, maxBytes = CAPABILITY_MAX_RESULT_BYTES): void {
  const ancestors = new Set<object>();
  let bytes = 0;
  const charge = (size: number) => {
    bytes += size;
    if (bytes > maxBytes) throw new Error("blocks_limit");
  };
  function visit(item: unknown, depth: number): void {
    if (depth > BLOCK_LIMITS.depth * 3) throw new Error("blocks_limit");
    if (typeof item === "string") {
      charge(new TextEncoder().encode(JSON.stringify(item)).byteLength);
      return;
    }
    if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) {
      charge(String(item).length);
      return;
    }
    if (typeof item !== "object" || ancestors.has(item)) throw new Error("blocks_data_only");
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
      throw new Error("blocks_data_only");
    ancestors.add(item);
    charge(2);
    let count = 0;
    for (const key of Reflect.ownKeys(item)) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || unsafeBlockKey(key)) throw new Error("blocks_data_only");
      if (array && key !== String(count)) throw new Error("blocks_data_only");
      const prop = Object.getOwnPropertyDescriptor(item, key)!;
      if (!prop.enumerable || !Object.hasOwn(prop, "value")) throw new Error("blocks_data_only");
      if (!array) charge(new TextEncoder().encode(JSON.stringify(key)).byteLength + 1);
      if (count++) charge(1);
      visit(prop.value, depth + 1);
    }
    if (array && count !== item.length) throw new Error("blocks_data_only");
    ancestors.delete(item);
  }
  visit(value, 0);
}

/** Portable chart schemas strip unknown keys; block contracts must reject them. */
export function assertNoDroppedBlockKeys(original: unknown, parsed: unknown): void {
  if (!original || typeof original !== "object") return;
  if (!parsed || typeof parsed !== "object") throw new Error("blocks_unknown_field");
  for (const [key, value] of Object.entries(original)) {
    if (!Object.hasOwn(parsed, key)) throw new Error("blocks_unknown_field");
    assertNoDroppedBlockKeys(value, Object.getOwnPropertyDescriptor(parsed, key)?.value);
  }
}
