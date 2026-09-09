import type { User } from "@k2b/cloud/contracts";

export type CloudSession = {
  sessionToken: string;
  user: User;
};

const normalizeBaseUrl = (baseUrl: string): string => {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
};

const readJsonError = async (res: Response, fallback: string): Promise<string> => {
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? fallback;
};

const withTimeout = (ms = 8_000): AbortSignal => AbortSignal.timeout(ms);

export const cloudClient = {
  normalizeBaseUrl,

  adminLogin: async (baseUrl: string, adminToken: string): Promise<CloudSession> => {
    const root = normalizeBaseUrl(baseUrl);
    const res = await fetch(`${root}/api/auth/admin-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: adminToken }),
      signal: withTimeout(),
    });

    if (!res.ok) {
      throw new Error(await readJsonError(res, `Cloud login failed (${res.status})`));
    }

    const body = (await res.json()) as { session_token?: string; user?: User };
    if (!body.session_token || !body.user) {
      throw new Error("Cloud login returned an incomplete session.");
    }

    return { sessionToken: body.session_token, user: body.user };
  },

  getMe: async (baseUrl: string, sessionToken: string): Promise<User> => {
    const root = normalizeBaseUrl(baseUrl);
    const res = await fetch(`${root}/api/me`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
      signal: withTimeout(),
    });

    if (!res.ok) {
      throw new Error(await readJsonError(res, `Cloud session check failed (${res.status})`));
    }

    return (await res.json()) as User;
  },
};
