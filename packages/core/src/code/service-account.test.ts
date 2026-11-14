import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { CODE_HANDLE_ALPHABET, createCodeServiceAccount } from "./service-account";

test("a handle collision redraws without aborting the caller transaction", async () => {
  const handles: string[] = [];
  const db = (async (_parts: TemplateStringsArray, ...values: unknown[]) => {
    handles.push(String(values[2]));
    return handles.length === 1 ? [] : [{ id: "same-account-uuid", handle: values[2] }];
  }) as unknown as SQL;
  const result = await createCodeServiceAccount(db, { name: "code:app:fixture", title: "Fixture", createdBy: "creator" });
  expect(new Set(CODE_HANDLE_ALPHABET).size).toBe(32);
  expect(handles).toHaveLength(2);
  for (const handle of handles) expect(String(handle)).toMatch(/^code-[0123456789abcdefghjkmnpqrstvwxyz]{10}$/);
  expect(result).toEqual({ id: "same-account-uuid", handle: String(handles[1]) });
});
