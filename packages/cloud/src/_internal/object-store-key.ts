// S3's complete object key, including the area, is limited to 1,024 UTF-8 bytes.
// Reject percent signs altogether, including nested encodings, before Bun sees a key.
export const validateObjectKey = (key: string, area: string, allowPrefix = false): string => {
  if (typeof key !== "string" || !key.isWellFormed() || key !== key.normalize("NFC") || /[\\%\p{Cc}\p{Cf}]/u.test(key)) {
    throw new TypeError("Object keys must be NFC text without controls, backslashes, or percent escapes.");
  }
  if (allowPrefix && key === "") return key;
  const path = allowPrefix && key.endsWith("/") ? key.slice(0, -1) : key;
  if (!path || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError("Object keys must be relative paths without empty, dot, or parent segments.");
  }
  if (Buffer.byteLength(area + key) > 1024) throw new RangeError("Object key exceeds S3's 1,024-byte limit including its area.");
  return key;
};
