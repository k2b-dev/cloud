import { invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities";
import { contactDirectory } from "@k2b/cloud/contracts";
import type { z } from "zod";
import type { ContactDirectoryTarget } from "../../contact-directory-settings";

export class ContactDirectoryUnavailableError extends Error {
  constructor() {
    super("No contact directory is configured for this function.");
    this.name = "ContactDirectoryUnavailableError";
  }
}

const invokeContactDirectory = async <T>(
  target: ContactDirectoryTarget | null,
  params: {
    kind: "query" | "action";
    input: unknown;
    dataSchema: z.ZodType<T>;
    signal?: AbortSignal;
    idempotencyKey?: string;
  },
) => {
  if (!target) throw new ContactDirectoryUnavailableError();
  const result = await invokeCapabilityWithDataSchema(
    {
      appId: target.appId,
      capabilityId: target.capabilityId,
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

export const suggestContacts = (
  target: ContactDirectoryTarget | null,
  input: z.input<typeof contactDirectory.suggest.input>,
  signal?: AbortSignal,
) => invokeContactDirectory(target, { kind: "query", input, dataSchema: contactDirectory.suggest.data, signal });

export const resolveContacts = (
  target: ContactDirectoryTarget | null,
  input: z.input<typeof contactDirectory.resolve.input>,
  signal?: AbortSignal,
) => invokeContactDirectory(target, { kind: "query", input, dataSchema: contactDirectory.resolve.data, signal });

export const readContact = (target: ContactDirectoryTarget | null, id: string, signal?: AbortSignal) =>
  invokeContactDirectory(target, { kind: "query", input: { id }, dataSchema: contactDirectory.read.data, signal });

export const listWritableContactBooks = (
  target: ContactDirectoryTarget | null,
  input: Omit<z.input<typeof contactDirectory.listWritableBooks.input>, "minimumPermission"> = {},
  signal?: AbortSignal,
) =>
  invokeContactDirectory(target, {
    kind: "query",
    input: { ...input, minimumPermission: "write" },
    dataSchema: contactDirectory.listWritableBooks.data,
    signal,
  });

export const createContact = (
  target: ContactDirectoryTarget | null,
  input: z.input<typeof contactDirectory.create.input>,
  idempotencyKey: string,
  signal?: AbortSignal,
) =>
  invokeContactDirectory(target, {
    kind: "action",
    input,
    dataSchema: contactDirectory.create.data,
    idempotencyKey,
    signal,
  });
