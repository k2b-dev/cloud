/** One cookie value from raw request headers, URL-decoded when possible. */
export const readCookie = (headers: Headers, name: string): string | undefined => {
  const cookie = headers.get("Cookie");
  if (!cookie) return undefined;

  for (const part of cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName !== name) continue;
    const value = rawValue.join("=");
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return undefined;
};
