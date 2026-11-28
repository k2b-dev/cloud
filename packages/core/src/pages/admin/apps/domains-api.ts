/** Reads the stable `code` of a failed domain request; a lost connection has none and reads as "try again". */
export const failure = async (response: { json(): Promise<unknown> } | null) => {
  const body = response ? ((await response.json().catch(() => null)) as { code?: string } | null) : null;
  return Object.assign(new Error(body?.code ?? "unknown"), { code: body?.code });
};

/** Conflicts that mean the shown list is old: read it again while the person's input stays. */
export const STALE = new Set(["APP_DOMAIN_REFERENCED", "APP_DOMAIN_REDIRECT_TARGET", "APP_DOMAIN_NOT_FOUND"]);
