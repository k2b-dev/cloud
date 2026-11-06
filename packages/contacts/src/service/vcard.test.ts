import { describe, expect, test } from "bun:test";
import type { Contact } from "./types";
import { CSV_HEADER_LINE, parse, serializeBook, serializeBookCsv, serializeBookPage, serializeContact, serializeCsvRows } from "./vcard";

const stamp = "2026-01-01T00:00:00.000Z";

const contact = (overrides: Partial<Contact> = {}): Contact => ({
  id: "contact-1",
  bookId: "book-1",
  label: "Vendor, Primary",
  firstName: "Ada",
  lastName: "Lovelace",
  companyName: "Analytical Engines GmbH",
  department: "Research;Development",
  jobTitle: "Chief Scientist",
  vatId: "DE123456789",
  birthday: "1815-12-10",
  salutation: "Dr.",
  pronouns: "she/her",
  preferredLanguage: "en",
  source: null,
  createdAt: stamp,
  updatedAt: stamp,
  emails: [
    {
      id: "email-1",
      contactId: "contact-1",
      label: "Work",
      email: "ada@example.test",
      position: 0,
      createdAt: stamp,
      updatedAt: stamp,
    },
  ],
  phones: [
    {
      id: "phone-1",
      contactId: "contact-1",
      label: "Mobile",
      phone: "+49 123 456",
      position: 0,
      createdAt: stamp,
      updatedAt: stamp,
    },
  ],
  addresses: [
    {
      id: "address-1",
      contactId: "contact-1",
      label: "Office",
      recipientName: "Ada Lovelace",
      companyName: "Analytical Engines GmbH",
      line1: "Main Street 1",
      line2: "Suite 2",
      postalCode: "10115",
      city: "Berlin",
      stateRegion: "BE",
      countryCode: "DE",
      location: null,
      position: 0,
      createdAt: stamp,
      updatedAt: stamp,
    },
  ],
  websites: [
    {
      id: "website-1",
      contactId: "contact-1",
      label: "Work Website",
      url: "https://example.test/ada",
      position: 0,
      createdAt: stamp,
      updatedAt: stamp,
    },
  ],
  bankAccounts: [],
  parentContactId: null,
  parent: null,
  members: [],
  tags: [],
  ...overrides,
});

describe("vCard serialization", () => {
  test("concatenated pages preserve book bytes", () => {
    const first = [contact(), contact({ id: "contact-2", label: "Two" })];
    const second = [contact({ id: "contact-3", firstName: "Zoë" })];
    expect(serializeBookPage(first) + serializeBookPage(second)).toBe(serializeBook([...first, ...second]));
    expect(serializeBookPage([])).toBe("");
  });
  test("serializes core contact fields and multi-value data", () => {
    const output = serializeContact(contact());

    expect(output).toContain("BEGIN:VCARD\r\nVERSION:3.0");
    expect(output).toContain("FN:Ada Lovelace");
    expect(output).toContain("N:Lovelace;Ada;;;");
    expect(output).toContain("NICKNAME:Vendor\\, Primary");
    expect(output).toContain("ORG:Analytical Engines GmbH;Research\\;Development");
    expect(output).toContain("TITLE:Chief Scientist");
    expect(output).toContain("BDAY:1815-12-10");
    expect(output).toContain("X-VAT-ID:DE123456789");
    expect(output).toContain("URL;TYPE=workwebsite:https://example.test/ada");
    expect(output).toContain("EMAIL;TYPE=work:ada@example.test");
    expect(output).toContain("TEL;TYPE=mobile:+49 123 456");
    expect(output).toContain("ADR;TYPE=office:;Suite 2;Main Street 1;Berlin;BE;10115;DE");
    expect(output).toContain("\r\nEND:VCARD");
  });

  test("folds long lines and serializeBook terminates with CRLF", () => {
    const output = serializeBook([
      contact({
        label: "A".repeat(100),
        firstName: null,
        lastName: null,
        companyName: null,
      }),
    ]);

    expect(output).toContain(`NICKNAME:${"A".repeat(66)}\r\n ${"A".repeat(34)}`);
    expect(output.endsWith("\r\n")).toBe(true);
  });

  test("escapes phone and email values so they cannot add vCard properties", () => {
    const output = serializeContact(
      contact({
        emails: [
          {
            id: "email-1",
            contactId: "contact-1",
            label: "Work",
            email: "ada@example.test",
            position: 0,
            createdAt: stamp,
            updatedAt: stamp,
          },
        ],
        phones: [
          {
            id: "phone-1",
            contactId: "contact-1",
            label: "Mobile",
            phone: "+49 123\r\nX-INJECTED:yes",
            position: 0,
            createdAt: stamp,
            updatedAt: stamp,
          },
        ],
      }),
    );

    expect(output).toContain("TEL;TYPE=mobile:+49 123\\nX-INJECTED:yes");
    expect(output).not.toContain("\r\nX-INJECTED:yes");
  });
});

describe("vCard parsing", () => {
  test("parses multi-contact vCard payloads with escaped values and folded lines", () => {
    const raw = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Ada Lovelace",
      "N:Lovelace;Ada;;;",
      "NICKNAME:Vendor\\, Primary",
      "ORG:Analytical Engines GmbH;Research\\;Development",
      "TITLE:Chief Scientist",
      "BDAY:18151210",
      "X-VAT-ID:DE123456789",
      "EMAIL;TYPE=work,internet:ada@example.test",
      "TEL;Mobile:+49 123 456",
      "URL;TYPE=Homepage:https://example.test/ada",
      "ADR;TYPE=office:;Suite 2;Main Street 1;Berlin;BE;10115;de",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Only Label",
      "NOTE:Ignored",
      "END:VCARD",
      "",
    ].join("\r\n");

    expect(parse(raw)).toEqual([
      {
        label: "Vendor, Primary",
        firstName: "Ada",
        lastName: "Lovelace",
        companyName: "Analytical Engines GmbH",
        department: "Research;Development",
        jobTitle: "Chief Scientist",
        birthday: "1815-12-10",
        vatId: "DE123456789",
        emails: [{ label: "work", email: "ada@example.test" }],
        phones: [{ label: "mobile", phone: "+49 123 456" }],
        websites: [{ label: "homepage", url: "https://example.test/ada" }],
        addresses: [
          {
            label: "office",
            recipientName: null,
            companyName: null,
            line1: "Main Street 1",
            line2: "Suite 2",
            postalCode: "10115",
            city: "Berlin",
            stateRegion: "BE",
            countryCode: "DE",
          },
        ],
      },
      {
        label: "Only Label",
      },
    ]);
  });

  test("skips malformed and incomplete data without dropping the candidate", () => {
    const raw = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Fallback",
      "BDAY:not-a-date",
      "EMAIL:",
      "TEL:",
      "URL:",
      "ADR;TYPE=home:;;;;;;USA",
      "END:VCARD",
    ].join("\n");

    expect(parse(raw)).toEqual([{ label: "Fallback" }]);
  });
});

describe("CSV serialization", () => {
  test("concatenated pages preserve book bytes with exactly one header", () => {
    const first = [contact(), contact({ id: "contact-2", label: "Two" })];
    const second = [contact({ id: "contact-3", companyName: "Line 1\nLine 2" })];
    const output = CSV_HEADER_LINE + serializeCsvRows(first) + serializeCsvRows(second);
    expect(output).toBe(serializeBookCsv([...first, ...second]));
    expect(output.split(CSV_HEADER_LINE)).toHaveLength(2);
    expect(serializeCsvRows([])).toBe("");
    expect(serializeBookCsv([])).toBe(CSV_HEADER_LINE);
  });
  test("quotes cells with commas, quotes, and newlines", () => {
    const output = serializeBookCsv([
      contact({
        label: 'Needs "quotes"',
        companyName: "Line 1\nLine 2",
      }),
    ]);

    expect(output).toContain('"Needs ""quotes"""');
    expect(output).toContain('"Line 1\nLine 2"');
    expect(output.endsWith("\r\n")).toBe(true);
  });

  test("neutralizes spreadsheet formula cells", () => {
    const output = serializeBookCsv([
      contact({
        firstName: "=cmd|' /C calc'!A0",
        lastName: "+SUM(1,1)",
        companyName: ' @HYPERLINK("https://example.test")',
      }),
    ]);

    expect(output).toContain("'=cmd|' /C calc'!A0");
    expect(output).toContain(`"'+SUM(1,1)"`);
    expect(output).toContain(`"' @HYPERLINK(""https://example.test"")"`);
  });
});
