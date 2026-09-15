import type { sql } from "bun";

export const normalizeAccountEmail = (email: string): string => email.trim().toLowerCase();

/** Hold through the write (including a FreeIPA mutation), on the same transaction. */
export const lockAccountEmail = async (db: typeof sql, email: string): Promise<void> => {
  // Take the table's ordinary write lock before the advisory lock. Local POSIX
  // provisioning takes a stronger table lock first; this keeps their order compatible.
  await db`LOCK TABLE auth.users IN ROW EXCLUSIVE MODE`;
  await db`SELECT pg_advisory_xact_lock(hashtextextended('cloud:account-email:' || ${normalizeAccountEmail(email)}, 0))`;
};

export const findAccountsByEmail = (db: typeof sql, email: string) =>
  db<
    {
      id: string;
      uid: string;
      provider: "local" | "ipa";
      mail: string;
    }[]
  >`SELECT id, uid, provider, mail FROM auth.users WHERE lower(btrim(mail)) = ${normalizeAccountEmail(email)}`;

export const emailAlreadyUsed = () => ({ ok: false as const, error: "An account with this email already exists.", status: 409 as const });
