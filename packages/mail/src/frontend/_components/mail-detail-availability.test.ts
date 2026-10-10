import { describe, expect, test } from "bun:test";
import type { MailSelectionDetail } from "../../service/workspace";
import { describeUnavailableMailDetails, preserveUnavailableMailDetail } from "./mail-detail-availability";

const detail = (overrides: Partial<MailSelectionDetail> = {}): MailSelectionDetail => ({
  detailMessages: [],
  conversationSummary: null,
  conversationDrafts: [],
  detailError: null,
  collaborationState: null,
  conversationLocalTags: null,
  comments: [],
  commentsCursor: null,
  assignableUsers: [],
  activity: [],
  reminder: null,
  keep: null,
  collaborationError: null,
  detailErrors: {
    collaboration: null,
    tags: null,
    comments: null,
    assignableUsers: null,
    activity: null,
    reminder: null,
    keep: null,
    reference: null,
    summary: null,
    drafts: null,
  },
  selectedReference: null,
  ...overrides,
});

describe("Mail detail availability", () => {
  test("keeps last confirmed sections while exposing failed live fields", () => {
    const current = detail({
      comments: [{ id: "comment-1" }] as MailSelectionDetail["comments"],
      activity: [{ id: "activity-1" }] as MailSelectionDetail["activity"],
      selectedReference: "CASE-42",
    });
    const incoming = detail({
      detailErrors: {
        ...detail().detailErrors,
        comments: "Comments timed out",
        activity: "Activity timed out",
        reference: "Reference timed out",
      },
    });

    const reconciled = preserveUnavailableMailDetail(current, incoming);

    expect(reconciled.comments).toBe(current.comments);
    expect(reconciled.activity).toBe(current.activity);
    expect(reconciled.selectedReference).toBe("CASE-42");
    expect(reconciled.detailErrors.comments).toBe("Comments timed out");
  });

  test("accepts confirmed empty sections instead of retaining stale data", () => {
    const current = detail({ comments: [{ id: "comment-1" }] as MailSelectionDetail["comments"] });

    expect(preserveUnavailableMailDetail(current, detail()).comments).toEqual([]);
  });

  test("names unavailable sections in the reader's language instead of presenting them as empty", () => {
    const errors = { ...detail().detailErrors, comments: "Comments timed out", reminder: "Reminder timed out" };
    expect(describeUnavailableMailDetails(errors, "en")).toBe(
      "Could not refresh team notes and personal reminder. Previously loaded values remain visible where available.",
    );
    expect(describeUnavailableMailDetails(errors, "de")).toBe(
      "Folgende Bereiche konnten nicht aktualisiert werden: Interne Notizen und Persönliche Erinnerung. Bereits geladene Werte bleiben soweit verfügbar sichtbar.",
    );
    expect(describeUnavailableMailDetails(detail().detailErrors, "de")).toBeNull();
  });

  test("keeps the German sentence grammatical when a single singular section fails", () => {
    expect(describeUnavailableMailDetails({ ...detail().detailErrors, summary: "Summary timed out" }, "de")).toBe(
      "Folgende Bereiche konnten nicht aktualisiert werden: Zusammenfassung. Bereits geladene Werte bleiben soweit verfügbar sichtbar.",
    );
  });
});
