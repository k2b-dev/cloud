import { randomBytes } from "node:crypto";
import type { SQL } from "bun";

/** 50 random bits; a handle locates an account and never grants rights. */
export const CODE_HANDLE_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const createCodeAccountHandle = (): string =>
  `code-${Array.from(randomBytes(10), (byte) => CODE_HANDLE_ALPHABET[byte & 31]).join("")}`;

/** Insert under the unique handle index; a collision retries without aborting the surrounding transaction. */
export async function createCodeServiceAccount(db: SQL, input: { name: string; title: string; createdBy: string }) {
  for (;;) {
    const handle = createCodeAccountHandle();
    const [account] = await db<{ id: string; handle: string }[]>`
      INSERT INTO auth.service_accounts(name,kind,title,handle,created_by)
      VALUES(${input.name},'code',${input.title},${handle},${input.createdBy}::uuid)
      ON CONFLICT (handle) DO NOTHING RETURNING id, handle`;
    if (account) return account;
  }
}
