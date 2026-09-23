---
title: Provide a contact directory
navTitle: Contact directory
section: Platform services
order: 557
description: Implement the provider-neutral contact-directory contract so Mail can use your application for recipients and participant contacts.
tags: [capabilities, contacts, mail, contracts]
updated: 2026-09-23
---

# Provide a contact directory

The contact-directory contract lets an application serve the contacts that Mail
shows and uses. Mail uses the built-in Contacts app by default. Operators can
switch Mail to any application that publishes compatible capabilities,
for example a customer-management app. Contacts implements the same contract.
It gets no special treatment.

The contract is a set of schemas exported from `@k2b/cloud/contracts`. Your
application keeps its own domain, identifiers, permissions, and routes. It
declares ordinary [capabilities](/en/docs/platform/capabilities) whose published
input and result schemas are compatible with the contract.

## Functions

| Function | Kind | Input schema | Result schema | Mail needs it for | Contacts ID |
| --- | --- | --- | --- | --- | --- |
| `suggest` | Query | `ContactDirectorySuggestInputSchema` | `ContactDirectorySuggestDataSchema` | Recipient suggestions. Required. | `contact.suggest` |
| `resolve` | Query | `ContactDirectoryResolveInputSchema` | `ContactDirectoryResolveDataSchema` | Participant contacts in conversation details, related Mail, and Assistant drafts. Required. | `contact.resolve` |
| `read` | Query | `ContactDirectoryReadInputSchema` | `ContactDirectoryContactSchema` | **Compose email** from a contact reference. Optional. | `contact.read` |
| `listWritableBooks` | Query | `ContactDirectoryBookListInputSchema` | `ContactDirectoryBookListDataSchema` | Choosing where **New contact** saves. Optional. | `book.list` |
| `create` | Action | `ContactDirectoryCreateInputSchema` | `ContactDirectoryCreateDataSchema` | **New contact** in conversation details. Optional. | `contact.create` |

`contactDirectory` bundles the kind and both schemas of each function, and
`CONTACT_DIRECTORY_FUNCTIONS` lists the function names. The `create` Action
must declare `idempotency: "required"`. None of the functions may stream its
result.

A *book* is whatever groups your contacts: an address book, a customer segment,
or a single fixed collection. Every contact returns a `bookId` and, in `resolve`
results, a `bookName`.

## Implement the functions

Choose your own capability IDs. Reuse the contract input schemas directly or
declare your own compatible ones. Extend the result schemas with your fields and
identifier formats:

```ts
import { defineCapabilities } from "@k2b/cloud";
import {
  ContactDirectoryMatchSchema,
  ContactDirectoryResolveInputSchema,
  ContactDirectorySuggestInputSchema,
  ContactDirectorySuggestionSchema,
} from "@k2b/cloud/contracts";
import { ok } from "@k2b/stdlib";
import { z } from "zod";

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
      run: async ({ query, limit }, context) =>
        ok({ data: await suggestReadableCustomers(context.accessSubject, query, limit ?? 8) }),
    },
    "customer.match": {
      title: "Match customers by email",
      description: "Return every readable customer whose email address exactly matches one of the given addresses.",
      input: ContactDirectoryResolveInputSchema,
      data: z.object({ items: z.array(CustomerMatchSchema).max(50), matchedEmails: z.array(z.email().max(320)).max(100) }).strict(),
      openWorld: false,
      run: async ({ emails, limit }, context) =>
        ok({ data: await matchReadableCustomers(context.accessSubject, emails, limit ?? 25) }),
    },
  },
});
```

`suggestReadableCustomers` and `matchReadableCustomers` stand for your own
permission-aware service functions.

Keep these rules in each result:

- Return only contacts that the calling person can read. Mail calls your
  capabilities with that person's own access, never with an app credential, and
  shows exactly what you return.
- `resolve` matches exact, normalized email addresses. Return every readable
  match; Mail does not pick or merge contacts. Fill `matchedEmails` on each item
  and on the result.
- Give each `resolve` item a `ref` to one of your
  [resource types](/en/docs/platform/capabilities). Mail attaches it to
  Assistant drafts. Declare a reader Query on that type so Assistant can open
  it.
- Add an `open` [semantic link](/en/docs/platform/capabilities) to a contact to
  let Mail link to it. Without links, Mail shows the contact without a link.
- Respect the input `limit` and return a `page` cursor when more results exist.

## Understand compatibility

Mail checks each selected capability against its published JSON Schema when an
administrator saves the mapping. A capability is compatible when:

- **Kind.** It is a Query or Action as listed above; the `create` Action
  requires an idempotency key; it does not stream.
- **Input.** Your input accepts everything the contract may send. You may
  require only fields that the contract always sends; a closed input must
  declare every contract field; numeric and array bounds must include the
  contract's bounds; enums must include the contract values. String syntax,
  such as an identifier pattern or length, stays yours because Mail sends back
  only identifiers you issued.
- **Result.** Every result you can return satisfies the contract. Required
  fields are always present; types and nullability match; `email` and
  `date-time` formats match; arrays stay within the contract bounds. Extra
  fields, narrower types, literals, and your own identifier formats are fine.
  Identifiers are opaque strings; Mail attaches a `ref` to Assistant only when
  its `id` has 1 to 512 characters, like any Cloud resource reference.

The check is conservative. A JSON Schema keyword it does not understand makes
the capability incompatible rather than silently accepted. Mail also validates
every response with the contract schema at runtime, so an incompatible response
disables the dependent feature instead of breaking Mail.

Test compatibility with the same function Mail uses:

```ts
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { capabilityContractIssues, contactDirectory } from "@k2b/cloud/contracts";

const manifest = compileCapabilityManifest("crm", crmCapabilities);
const operation = manifest.queries.find((entry) => entry.localId === "customer.suggest");
if (!operation) throw new Error("customer.suggest is not declared");

// An empty list means Mail can select this Query for `suggest`.
const issues = capabilityContractIssues(contactDirectory.suggest, { kind: "query", operation });
```

Each issue names the `code` (`kind`, `idempotency`, `stream`, `input`, or
`data`), the JSON `path`, and a developer message.

## Connect Mail to your application

Administrators choose the provider in the **Contact directory** dialog on
**Administration → Mail**, or with `cld mail admin contact-directory`. Both
list every application with capabilities and, for each function, only the
compatible capabilities of the selected application; `cld mail admin
contact-directory candidates --app <id>` shows what Mail would accept from your
application.
`suggest` and `resolve` are required. Leave `read`, `listWritableBooks`, and
`create` empty to hide the Mail features that need them. `listWritableBooks`
and `create` work only together. The [Mail app page](/en/apps/mail) describes
the settings and their defaults.

Keep published capability IDs and result fields stable after an installation
uses them; follow [Evolve published local IDs additively](/en/docs/platform/capabilities).
