import { describe, expect, test } from "bun:test";
import type { Contact } from "../../service";
import { contactFormMessages, contactRowLabels } from "./contact-form-messages";
import {
  applyQuickEditFields,
  buildContactPayload,
  type ContactUpsertDraft,
  contactToUpsertDraft,
  createContactUpsertDraft,
  initialAddressRows,
  initialBankAccountRows,
  initialEmailRows,
} from "./ContactUpsertForm.model";

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
});
