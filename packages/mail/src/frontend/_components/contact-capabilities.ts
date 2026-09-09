import { invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities";
import type { z } from "zod";
import {
  contactBooksSchema,
  contactMutationDataSchema,
  contactResolveDataSchema,
  contactSuggestionsSchema,
} from "../../app-integration-contracts";

const invokeContactsCapability = async <T>(params: {
  kind: "query" | "action";
  id: string;
  input: unknown;
  dataSchema: z.ZodType<T>;
  signal?: AbortSignal;
  idempotencyKey?: string;
}) => {
  const result = await invokeCapabilityWithDataSchema(
    {
      appId: "contacts",
      capabilityId: params.id,
      kind: params.kind,
      input: params.input,
      signal: params.signal,
      idempotencyKey: params.idempotencyKey,
    },
    params.dataSchema,
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
};

export const suggestContacts = (input: { query: string; cursor?: string; limit?: number }, signal?: AbortSignal) =>
  invokeContactsCapability({
    kind: "query",
    id: "contact.suggest",
    input,
    dataSchema: contactSuggestionsSchema,
    signal,
  });

export const resolveContacts = (input: { emails: string[]; limit?: number }, signal?: AbortSignal) =>
  invokeContactsCapability({
    kind: "query",
    id: "contact.resolve",
    input,
    dataSchema: contactResolveDataSchema,
    signal,
  });

export const listWritableContactBooks = (input: { cursor?: string; query?: string; limit?: number } = {}, signal?: AbortSignal) =>
  invokeContactsCapability({
    kind: "query",
    id: "book.list",
    input: { ...input, minimumPermission: "write" },
    dataSchema: contactBooksSchema,
    signal,
  });

export const createContact = (
  input: {
    bookId: string;
    label?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    companyName?: string | null;
    emails?: { label?: string | null; email: string }[];
    phones?: { label?: string | null; phone: string }[];
  },
  idempotencyKey: string,
  signal?: AbortSignal,
) =>
  invokeContactsCapability({
    kind: "action",
    id: "contact.create",
    input,
    dataSchema: contactMutationDataSchema,
    idempotencyKey,
    signal,
  });
