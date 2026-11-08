/** Keys a data path may never name. */
export const unsafeBlockKey = (key: string): boolean => ["__proto__", "constructor", "prototype"].includes(key);

/** Own data descriptors only. The public capability helper uses this same path resolver. */
export function blockDataAtPath(data: unknown, path: readonly string[]): unknown {
  if (path.length > 16 || path.some((key) => typeof key !== "string" || key.length > 500 || unsafeBlockKey(key)))
    throw new Error("blocks_path");
  let value = data;
  for (const segment of path) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, segment)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, segment);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("blocks_data_only");
    value = descriptor.value;
  }
  return value;
}
