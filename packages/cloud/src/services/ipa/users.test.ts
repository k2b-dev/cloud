import { expect, spyOn, test } from "bun:test";
import { generateUniqueAbbreviation } from "./users";

test("ordinary account UID generation reserves admin even before the emergency account exists", async () => {
  // Rejection-sampling bytes deterministically spell the reserved UID on every attempt.
  const random = spyOn(crypto, "getRandomValues").mockImplementation((array: Uint8Array) => {
    array.set([0, 3, 12, 8, 13]);
    return array;
  });
  try {
    await expect(generateUniqueAbbreviation(5, 2)).rejects.toThrow("Failed to generate unique abbreviation after 2 attempts");
    expect(random).toHaveBeenCalledTimes(2);
  } finally {
    random.mockRestore();
  }
});
