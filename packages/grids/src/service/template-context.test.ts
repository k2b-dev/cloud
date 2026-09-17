import { expect, test } from "bun:test";
import { DocumentDefaultsSchema } from "../contracts";
import {
  buildTemplateAppData,
  DOCUMENT_BUSINESS_KEYS,
  documentBusinessSnapshot,
  templateBusinessDataFromDefaults,
} from "./template-context";

test("Base defaults project structured issuer details without rewriting existing address lines", () => {
  const address = "  Example Street 1\nBuilding B  \n";
  const defaults = DocumentDefaultsSchema.parse({
    legalName: "Example GmbH",
    address,
    postalCode: "89073",
    city: "Ulm",
    countryCode: "de",
    taxId: "12/345/67890",
    vatId: "DE123456789",
    accountName: "Example GmbH",
    iban: "DE89370400440532013000",
  });
  expect(defaults.address).toBe(address);
  expect(defaults.countryCode).toBe("DE");
  const business = templateBusinessDataFromDefaults(defaults);
  expect(business).toMatchObject({ ...defaults, countryCode: "DE" });
  expect(business.senderLine).toContain("89073 Ulm | DE");
  expect(business.address).toBe(address);
  expect(templateBusinessDataFromDefaults({ address: "Old Street 1\n89073 Ulm" })).toMatchObject({
    address: "Old Street 1\n89073 Ulm",
    postalCode: null,
    city: null,
    countryCode: null,
  });
});

test("missing business identity stays empty while separate app branding and contact fallbacks remain available", async () => {
  const app = await buildTemplateAppData({ app: { name: "Example Cloud", url: "cloud.example.test", contact_email: "help@example.test" } });
  const business = templateBusinessDataFromDefaults({}, app);
  expect(app.name).toBe("Example Cloud");
  expect(business).toMatchObject({
    legalName: "",
    senderLine: "",
    address: "",
    postalCode: null,
    city: null,
    countryCode: null,
    vatId: null,
    accountName: null,
    contactEmail: "help@example.test",
    url: "https://cloud.example.test",
  });
  expect(templateBusinessDataFromDefaults({ legalName: "Actual issuer", senderLine: "Chosen sender" }, app)).toMatchObject({
    legalName: "Actual issuer",
    senderLine: "Chosen sender",
  });
});

test("generic document defaults reject malformed country codes and unknown issuer metadata", () => {
  for (const countryCode of ["", "D", "DEU", "D1"]) expect(DocumentDefaultsSchema.safeParse({ countryCode }).success).toBe(false);
  expect(DocumentDefaultsSchema.safeParse({ ready: true }).success).toBe(false);
});

test("document business snapshots expose only captured canonical string values without normalizing them", () => {
  const business = {
    legalName: " Original issuer ",
    address: " Street 1\nBuilding B  \n",
    countryCode: "de",
    vatId: "",
    accountName: "Original holder",
    postalCode: 89073,
    privateKey: "never exposed",
  };
  const before = structuredClone(business);
  const snapshot = documentBusinessSnapshot({ business, rows: [{ unrelated: "never exposed" }] });
  expect(snapshot).toMatchObject({
    legalName: " Original issuer ",
    address: " Street 1\nBuilding B  \n",
    countryCode: "de",
    vatId: "",
    accountName: "Original holder",
    postalCode: null,
    city: null,
  });
  expect(Object.keys(snapshot ?? {}).sort()).toEqual([...DOCUMENT_BUSINESS_KEYS].sort());
  expect(snapshot).not.toHaveProperty("privateKey");
  expect(snapshot).not.toHaveProperty("rows");
  expect(business).toEqual(before);
  for (const value of [undefined, null, false, "issuer", 42, []]) {
    expect(documentBusinessSnapshot({ business: value })).toBeNull();
  }
  expect(documentBusinessSnapshot({})).toBeNull();
});
