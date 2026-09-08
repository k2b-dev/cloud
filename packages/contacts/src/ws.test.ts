import { expect, test } from "bun:test";
import { resolveContactLiveCursor } from "./ws";

test("resolveContactLiveCursor keeps a client cursor and resolves the head only for null", async () => {
  let lookups = 0;
  const latest = async () => {
    lookups += 1;
    return "s6t.contacts.42";
  };
  expect(await resolveContactLiveCursor("s6t.contacts.7", latest)).toBe("s6t.contacts.7");
  expect(lookups).toBe(0);
  expect(await resolveContactLiveCursor(null, latest)).toBe("s6t.contacts.42");
  expect(lookups).toBe(1);
  await expect(resolveContactLiveCursor(null, () => Promise.reject(new Error("timed out")))).rejects.toThrow("timed out");
});
