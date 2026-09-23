import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { compileCapabilityManifest } from "../capabilities/testing";
import { type CapabilityDefinitions, type CapabilityInvocationResult, defineCapabilities } from "./capabilities";
import { capabilityContractIssues } from "./capability-compatibility";
import {
  ContactDirectoryMatchSchema,
  ContactDirectoryResolveInputSchema,
  ContactDirectorySuggestInputSchema,
  ContactDirectorySuggestionSchema,
  contactDirectory,
} from "./contact-directory";

const run = (): CapabilityInvocationResult<never> => ({
  ok: false,
  error: { code: "INTERNAL", message: "Not invoked in this test.", status: 500 },
});

const manifestOf = (definitions: CapabilityDefinitions) => compileCapabilityManifest("crm", definitions);

const query = (definitions: CapabilityDefinitions, id: string) => {
  const operation = manifestOf(definitions).queries.find((entry) => entry.localId === id);
  if (!operation) throw new Error(`Missing ${id}`);
  return { kind: "query" as const, operation };
};

const suggestProvider = (input: z.ZodType, data: z.ZodType) =>
  query(
    defineCapabilities({
      protocolVersion: 2,
      queries: { "customer.suggest": { title: "Suggest", description: "Suggest.", input, data, openWorld: false, run } },
    }),
    "customer.suggest",
  );

const ProviderSuggestionSchema = z
  .object({
    customerNumber: z.string().describe("Provider-only field."),
    contactId: z.uuid(),
    bookId: z.literal("customers"),
    displayName: z.string().min(1),
    companyName: z.string().nullable(),
    jobTitle: z.string().nullable(),
    emails: z
      .array(z.object({ label: z.string().nullable(), email: z.email(), primary: z.boolean() }).strict())
      .min(1)
      .max(5),
    phones: z.array(z.object({ label: z.string().nullable(), phone: z.string().min(1) }).strict()).max(5),
    contactPointsTruncated: z.boolean(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

describe("capabilityContractIssues", () => {
  test("accepts a provider that reuses the contract schemas", () => {
    expect(
      capabilityContractIssues(
        contactDirectory.suggest,
        suggestProvider(ContactDirectorySuggestInputSchema, z.array(ContactDirectorySuggestionSchema).max(25)),
      ),
    ).toEqual([]);
  });

  test("accepts narrower provider results, extra fields, and provider-owned identifier formats", () => {
    const input = z
      .object({
        query: z.string().trim().min(1).max(1000).describe("Search text."),
        cursor: z.string().regex(/^c_/).optional().describe("Cursor."),
        limit: z.number().int().min(1).max(50).default(10).describe("Limit."),
        segment: z.enum(["all", "active"]).default("all").describe("Provider-only filter."),
      })
      .strict();
    expect(capabilityContractIssues(contactDirectory.suggest, suggestProvider(input, z.array(ProviderSuggestionSchema).max(10)))).toEqual(
      [],
    );
  });

  test("reports result fields the provider does not guarantee", () => {
    const data = z.array(ProviderSuggestionSchema.extend({ displayName: z.string().min(1).nullable() }).strict()).max(10);
    expect(capabilityContractIssues(contactDirectory.suggest, suggestProvider(ContactDirectorySuggestInputSchema, data))).toEqual([
      { code: "data", path: "$[].displayName", message: "allows null but the contract expects string" },
    ]);
    const unbounded = z.array(ProviderSuggestionSchema);
    expect(capabilityContractIssues(contactDirectory.suggest, suggestProvider(ContactDirectorySuggestInputSchema, unbounded))).toEqual([
      { code: "data", path: "$", message: "must contain at most 25 items" },
    ]);
    const missing = z.array(ProviderSuggestionSchema.omit({ updatedAt: true }).strict()).max(10);
    expect(capabilityContractIssues(contactDirectory.suggest, suggestProvider(ContactDirectorySuggestInputSchema, missing))).toEqual([
      { code: "data", path: "$[].updatedAt", message: "must always be returned" },
    ]);
  });

  test("reports input the provider would reject", () => {
    const data = z.array(ProviderSuggestionSchema).max(10);
    const requiresMore = ContactDirectorySuggestInputSchema.extend({ tenant: z.string().describe("Tenant.") }).strict();
    expect(capabilityContractIssues(contactDirectory.suggest, suggestProvider(requiresMore, data))).toEqual([
      { code: "input", path: "$.tenant", message: "is required by the provider but optional in the contract" },
    ]);
    const noLimit = ContactDirectorySuggestInputSchema.omit({ limit: true }).strict();
    expect(capabilityContractIssues(contactDirectory.suggest, suggestProvider(noLimit, data))).toEqual([
      { code: "input", path: "$.limit", message: "is not accepted" },
    ]);
    const smallLimit = ContactDirectorySuggestInputSchema.extend({
      limit: z.number().int().min(1).max(10).optional().describe("Limit."),
    }).strict();
    expect(capabilityContractIssues(contactDirectory.suggest, suggestProvider(smallLimit, data))).toEqual([
      { code: "input", path: "$.limit", message: "allows numbers outside the contract range" },
    ]);
  });

  test("checks the operation kind, idempotency, and literal values", () => {
    expect(
      capabilityContractIssues(
        contactDirectory.create,
        suggestProvider(ContactDirectorySuggestInputSchema, z.array(ProviderSuggestionSchema).max(10)),
      ),
    ).toEqual([{ code: "kind", path: "$", message: "Expected an Action" }]);
    const manifest = manifestOf(
      defineCapabilities({
        protocolVersion: 2,
        actions: {
          "customer.create": {
            title: "Create",
            description: "Create.",
            input: contactDirectory.create.input,
            data: contactDirectory.create.data,
            destructive: false,
            openWorld: false,
            idempotency: "none",
            run,
          },
        },
      }),
    );
    const action = manifest.actions[0];
    if (!action) throw new Error("Missing action");
    expect(capabilityContractIssues(contactDirectory.create, { kind: "action", operation: action })).toEqual([
      { code: "idempotency", path: "$", message: "The Action must require an idempotency key" },
    ]);

    const wrongRef = z
      .object({
        items: z
          .array(
            ContactDirectoryMatchSchema.extend({
              ref: z.object({ type: z.literal("Customers"), id: z.string().min(1).max(40) }).strict(),
            }).strict(),
          )
          .max(50),
        matchedEmails: z.array(z.email().max(320)).max(100),
      })
      .strict();
    const resolve = query(
      defineCapabilities({
        protocolVersion: 2,
        queries: {
          "customer.resolve": {
            title: "Resolve",
            description: "Resolve.",
            input: ContactDirectoryResolveInputSchema,
            data: wrongRef,
            openWorld: false,
            run,
          },
        },
      }),
      "customer.resolve",
    );
    expect(capabilityContractIssues(contactDirectory.resolve, resolve)).toEqual([
      { code: "data", path: "$.items[].ref.type", message: "value does not match the pattern" },
    ]);
  });
});
