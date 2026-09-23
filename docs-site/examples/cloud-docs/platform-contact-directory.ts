import { defineCapabilities } from "@k2b/cloud";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import {
  type AccessSubject,
  ContactDirectoryMatchSchema,
  ContactDirectoryResolveInputSchema,
  ContactDirectorySuggestInputSchema,
  ContactDirectorySuggestionSchema,
  capabilityContractIssues,
  contactDirectory,
} from "@k2b/cloud/contracts";
import { ok } from "@k2b/stdlib";
import { z } from "zod";

type Customer = {
  id: string;
  ownerId: string;
  name: string;
  company: string | null;
  email: string;
  customerNumber: string;
  updatedAt: string;
};

const customers: Customer[] = [
  {
    id: "c9a1f7de-5a53-4f67-9e3c-0f1a2b3c4d5e",
    ownerId: "user-42",
    name: "Ada Example",
    company: "Example Ltd",
    email: "ada@example.test",
    customerNumber: "K-1001",
    updatedAt: "2026-09-20T08:00:00.000Z",
  },
];

// Your app enforces its own permissions: return only customers the caller can read.
const readableCustomers = (subject: AccessSubject): Customer[] =>
  customers.filter((customer) => subject.type === "user" && subject.userId === customer.ownerId);

const customerFacts = (customer: Customer) => ({
  contactId: customer.id,
  bookId: "customers",
  displayName: customer.name,
  companyName: customer.company,
  jobTitle: null,
  emails: [{ label: null, email: customer.email }],
  phones: [],
  contactPointsTruncated: false,
  links: [{ rel: "open" as const, href: `/app/crm/customers/${customer.id}` }],
  updatedAt: customer.updatedAt,
  customerNumber: customer.customerNumber,
});

// Extra result fields and your own identifier format are allowed.
const CustomerSuggestionSchema = ContactDirectorySuggestionSchema.extend({
  contactId: z.uuid(),
  bookId: z.literal("customers"),
  customerNumber: z.string(),
}).strict();

const CustomerMatchSchema = ContactDirectoryMatchSchema.extend({
  ref: z.object({ type: z.literal("crm.customer"), id: z.uuid() }).strict(),
  contactId: z.uuid(),
  bookId: z.literal("customers"),
  customerNumber: z.string(),
}).strict();

export const crmCapabilities = defineCapabilities({
  protocolVersion: 2,
  types: {
    customer: { title: "Customer", description: "One customer record.", icon: "ti ti-user" },
  },
  queries: {
    "customer.suggest": {
      title: "Suggest customers",
      description: "Suggest readable customers with an email address while someone types a recipient.",
      input: ContactDirectorySuggestInputSchema,
      data: z.array(CustomerSuggestionSchema).max(25),
      openWorld: false,
      run: async ({ query, limit }, context) => {
        const needle = query.trim().toLowerCase();
        const matches = readableCustomers(context.accessSubject)
          .filter((customer) => `${customer.name} ${customer.email}`.toLowerCase().includes(needle))
          .slice(0, limit ?? 8);
        return ok({ data: matches.map(customerFacts) });
      },
    },
    "customer.match": {
      title: "Match customers by email",
      description: "Return every readable customer whose email address exactly matches one of the given addresses.",
      input: ContactDirectoryResolveInputSchema,
      data: z.object({ items: z.array(CustomerMatchSchema).max(50), matchedEmails: z.array(z.email().max(320)).max(100) }).strict(),
      openWorld: false,
      run: async ({ emails, limit }, context) => {
        const wanted = new Set(emails);
        const matches = readableCustomers(context.accessSubject)
          .filter((customer) => wanted.has(customer.email))
          .slice(0, limit ?? 25);
        return ok({
          data: {
            items: matches.map((customer) => ({
              ...customerFacts(customer),
              ref: { type: "crm.customer" as const, id: customer.id },
              bookName: "Customers",
              matchedEmails: [customer.email],
            })),
            matchedEmails: [...new Set(matches.map((customer) => customer.email))],
          },
        });
      },
    },
  },
});

// Run the same check Mail runs when an administrator selects your capabilities.
const manifest = compileCapabilityManifest("crm", crmCapabilities);
const query = (localId: string) => {
  const operation = manifest.queries.find((entry) => entry.localId === localId);
  if (!operation) throw new Error(`${localId} is not declared`);
  return { kind: "query" as const, operation };
};

export const suggestIssues = capabilityContractIssues(contactDirectory.suggest, query("customer.suggest"));
export const resolveIssues = capabilityContractIssues(contactDirectory.resolve, query("customer.match"));
