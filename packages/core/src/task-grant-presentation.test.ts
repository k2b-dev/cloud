import { expect, spyOn, test } from "bun:test";
import * as catalog from "@k2b/cloud/capabilities/server";
import { taskGrantReview } from "./task-grant-presentation";

test("task access review distinguishes unrestricted inputs, exact restrictions and no access", async () => {
  const lookup = spyOn(catalog, "getCapabilityCatalogApp").mockResolvedValue({ ok: true, data: null });
  try {
    const none = await taskGrantReview([], "de");
    expect(none.value).toBe("Keine zusätzlichen Zugriffe.");
    const review = await taskGrantReview(
      [
        { appId: "spaces", capabilityId: "event.agenda", kind: "query", fixedInput: {} },
        { appId: "notebooks", capabilityId: "note.update", kind: "action", fixedInput: { noteId: "abc123" } },
      ],
      "de",
    );
    expect(review.format).toBe("markdown");
    expect(review.value).toContain("**event\\.agenda**");
    expect(review.label).toBe("Das erlaubst du dieser Aufgabe");
    expect(review.value).not.toContain("Aktion ausführen");
    expect(review.value).toContain("Keine Einschränkung auf bestimmte Inhalte");
    expect(review.value).toContain("noteId: abc123");
    expect(review.value.split("\n\n")[1]).toBe(
      "**note\\.update** · notebooks  \nFestgelegt: noteId: abc123\\. Andere Eingaben darf die Aufgabe selbst wählen\\.",
    );
    expect(review.value).not.toContain('"fixedInput"');
    expect(lookup).toHaveBeenCalledWith("spaces", "de");
  } finally {
    lookup.mockRestore();
  }
});
