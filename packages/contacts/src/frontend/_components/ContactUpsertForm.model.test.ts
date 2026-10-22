import { describe, expect, test } from "bun:test";
import type { Contact } from "../../service";
import {
  applyQuickEditFields,
  buildContactPayload,
  type ContactUpsertDraft,
  contactToUpsertDraft,
  createContactUpsertDraft,
  type EditableAddress,
  editAddressField,
  emptyAddressRow,
  initialAddressRows,
  initialBankAccountRows,
  initialEmailRows,
  pickAddressSuggestion,
} from "./ContactUpsertForm.model";
import { contactFormMessages, contactRowLabels } from "./contact-form-messages";

const rowLabels = contactRowLabels(contactFormMessages.resolve(["en"]).t);

const baseContact: Contact = {
  id: "contact-1",
  bookId: "book-1",
  label: null,
  firstName: "Ada",
  lastName: "Lovelace",
  companyName: null,
  department: null,
  jobTitle: null,
  vatId: null,
  birthday: null,
  salutation: null,
  pronouns: null,
  preferredLanguage: null,
  source: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  emails: [],
  phones: [],
  addresses: [],
  websites: [],
  bankAccounts: [],
  parentContactId: null,
  parent: null,
  members: [],
  tags: [],
};

const baseDraft: ContactUpsertDraft = {
  label: " Ada ",
  firstName: " Ada ",
  lastName: " Lovelace ",
  companyName: " Analytical Engines ",
  department: "",
  jobTitle: " Scientist ",
  vatId: "",
  birthday: "1815-12-10",
  salutation: "",
  pronouns: "",
  preferredLanguage: " en ",
  parentRef: {
    id: "parent-1",
    label: "Parent",
    firstName: null,
    lastName: null,
    companyName: "Parent Co",
    jobTitle: null,
  },
  tagIds: ["tag-1"],
  emails: [{ label: " Work ", email: " ada@example.test " }],
  phones: [{ label: " Mobile ", phone: " +49 123 " }],
  websites: [{ label: "", url: " https://example.test " }],
  addresses: [
    {
      label: " Office ",
      recipientName: "",
      companyName: " Analytical Engines ",
      line1: " Main Street 1 ",
      line2: "",
      postalCode: " 10115 ",
      city: " Berlin ",
      stateRegion: " be ",
      countryCode: " de ",
      geo: "idle",
      location: null,
    },
  ],
  bankAccounts: [
    {
      label: " Billing ",
      accountHolderName: " Ada Lovelace ",
      iban: " de02 1203 0000 0000 2020 51 ",
      bic: " byla dem 1001 ",
      bankName: "",
      note: " Main account ",
    },
  ],
};

describe("ContactUpsertForm model", () => {
  test("creates a minimal prefilled draft without guessing name structure", () => {
    const draft = createContactUpsertDraft({ label: " Ada Example ", email: " ada@example.test " }, rowLabels);

    expect(draft.label).toBe("Ada Example");
    expect(draft.firstName).toBe("");
    expect(draft.lastName).toBe("");
    expect(draft.emails).toEqual([{ label: "Email", email: "ada@example.test" }]);
  });

  for (const [locale, emailLabel, phoneLabel] of [
    ["de", "E-Mail", "Telefon"],
    ["en", "Email", "Telephone"],
  ] satisfies [string, string, string][]) {
    test(`quick edits seed ${locale} labels for new email and phone rows`, () => {
      const labels = contactRowLabels(contactFormMessages.resolve([locale]).t);
      const payload = buildContactPayload(
        applyQuickEditFields(
          baseContact,
          {
            label: "Ada",
            firstName: "Ada",
            lastName: "Lovelace",
            companyName: "",
            jobTitle: "",
            parentRef: null,
            tagIds: [],
            email: "ada@example.test",
            phone: "+49 123",
          },
          labels,
        ),
      );
      expect(payload.emails).toEqual([{ label: emailLabel, email: "ada@example.test" }]);
      expect(payload.phones).toEqual([{ label: phoneLabel, phone: "+49 123" }]);
    });
  }

  test("normalizes draft rows into a create/update payload", () => {
    expect(buildContactPayload(baseDraft)).toEqual({
      label: "Ada",
      firstName: "Ada",
      lastName: "Lovelace",
      companyName: "Analytical Engines",
      department: null,
      jobTitle: "Scientist",
      vatId: null,
      birthday: "1815-12-10",
      salutation: null,
      pronouns: null,
      preferredLanguage: "en",
      parentContactId: "parent-1",
      tagIds: ["tag-1"],
      emails: [{ label: "Work", email: "ada@example.test" }],
      phones: [{ label: "Mobile", phone: "+49 123" }],
      websites: [{ label: null, url: "https://example.test" }],
      addresses: [
        {
          label: "Office",
          recipientName: null,
          companyName: "Analytical Engines",
          line1: "Main Street 1",
          line2: null,
          postalCode: "10115",
          city: "Berlin",
          stateRegion: "be",
          countryCode: "DE",
        },
      ],
      bankAccounts: [
        {
          label: "Billing",
          accountHolderName: "Ada Lovelace",
          iban: "DE02120300000000202051",
          bic: "BYLADEM1001",
          bankName: null,
          note: "Main account",
        },
      ],
    });
  });

  test("keeps empty default contact rows for create and edit forms", () => {
    expect(initialEmailRows(null, rowLabels)).toEqual([{ label: "Email", email: "" }]);
    expect(initialEmailRows(baseContact, rowLabels)).toEqual([{ label: "Email", email: "" }]);
    expect(initialAddressRows(baseContact, rowLabels)).toEqual([
      {
        label: "Address",
        recipientName: "",
        companyName: "",
        line1: "",
        line2: "",
        postalCode: "",
        city: "",
        stateRegion: "",
        countryCode: "DE",
        geo: "idle",
        location: null,
      },
    ]);
    expect(initialBankAccountRows(baseContact, rowLabels)).toEqual([]);
  });

  test("preserves non-quick-edit fields when converting an existing contact", () => {
    const contact: Contact = {
      ...baseContact,
      department: "Research",
      birthday: "1815-12-10",
      parentContactId: "parent-1",
      parent: baseDraft.parentRef,
      tags: [
        {
          id: "tag-1",
          bookId: "book-1",
          name: "VIP",
          color: "#16a34a",
          createdAt: baseContact.createdAt,
          updatedAt: baseContact.updatedAt,
        },
      ],
      websites: [
        {
          id: "website-1",
          contactId: baseContact.id,
          label: "Portfolio",
          url: "https://example.test",
          position: 0,
          createdAt: baseContact.createdAt,
          updatedAt: baseContact.updatedAt,
        },
      ],
    };

    const payload = buildContactPayload({
      ...contactToUpsertDraft(contact, rowLabels),
      companyName: "Analytical Engines",
    });

    expect(payload.department).toBe("Research");
    expect(payload.birthday).toBe("1815-12-10");
    expect(payload.parentContactId).toBe("parent-1");
    expect(payload.tagIds).toEqual(["tag-1"]);
    expect(payload.websites).toEqual([{ label: "Portfolio", url: "https://example.test" }]);
  });

  test("validates partial address, bank account, and birthday values", () => {
    expect(() =>
      buildContactPayload({
        ...baseDraft,
        addresses: [{ ...baseDraft.addresses[0]!, city: "" }],
      }),
    ).toThrow("Addresses need line1, postal code, and city");
    expect(() =>
      buildContactPayload({
        ...baseDraft,
        bankAccounts: [{ ...baseDraft.bankAccounts[0]!, iban: "" }],
      }),
    ).toThrow("Bank details need account holder name and IBAN");
    expect(() => buildContactPayload({ ...baseDraft, birthday: "12/10/1815" })).toThrow("Birthday must use format YYYY-MM-DD");
  });

  test("rejects unsafe website URLs", () => {
    expect(() =>
      buildContactPayload({
        ...baseDraft,
        websites: [{ label: "Website", url: "javascript:alert(1)" }],
      }),
    ).toThrow("Website URL must start with http:// or https://");
  });
  test("a picked suggestion travels with its fields until a location field changes", () => {
    const provenance = {
      provider: "geoapify" as const,
      attribution: {
        text: "Geoapify · OpenStreetMap" as const,
        links: ["https://geoapify.com", "https://www.openstreetmap.org/copyright"],
      },
      computedAt: "2026-10-22T10:00:00.000Z",
    };
    const empty = emptyAddressRow(rowLabels);
    const suggestion = {
      line1: "Frauenstraße 28",
      postalCode: "89073",
      city: "Ulm",
      stateRegion: "Baden-Württemberg",
      countryCode: "DE",
      point: { lat: 48.4, lon: 9.99 },
      formatted: "Frauenstraße 28, 89073 Ulm, Germany",
      confidence: 1,
      buildingConfidence: 1,
      provenance,
    };
    const picked = pickAddressSuggestion(empty, suggestion);
    expect(picked).toMatchObject({
      line1: "Frauenstraße 28",
      postalCode: "89073",
      city: "Ulm",
      countryCode: "DE",
      stateRegion: "Baden-Württemberg",
      geo: "picked",
    });
    // Fields the suggestion lacks are cleared, never kept from the previous address beside the new point.
    expect(
      pickAddressSuggestion({ ...empty, postalCode: "89073", stateRegion: "Bayern" }, { ...suggestion, postalCode: "", stateRegion: "" }),
    ).toMatchObject({ postalCode: "", stateRegion: "" });
    const payload = (row: EditableAddress) => buildContactPayload({ ...baseDraft, addresses: [row] }).addresses?.[0];
    expect(payload(picked)?.location).toEqual({ point: { lat: 48.4, lon: 9.99 }, provenance });

    // Label, recipient and the second line do not move the building.
    expect(editAddressField(picked, "line2", "3rd floor")).toMatchObject({ geo: "picked", location: { point: { lat: 48.4 } } });
    const changed = editAddressField(picked, "line1", "Frauenstraße 30");
    expect(changed).toMatchObject({ geo: "changed", location: null });
    expect(payload(changed)).not.toHaveProperty("location");

    // A known location is dropped the same way; an own entry stays own; an untouched row stays pending.
    expect(editAddressField({ ...empty, line1: "A 1", geo: "known" }, "city", "Ulm")).toMatchObject({ geo: "changed" });
    expect(editAddressField({ ...empty, geo: "own" }, "city", "Ulm")).toMatchObject({ geo: "own" });
    expect(editAddressField(empty, "city", "Ulm")).toMatchObject({ geo: "idle" });
    expect(editAddressField(picked, "city", "Ulm")).toBe(picked);
  });
});
