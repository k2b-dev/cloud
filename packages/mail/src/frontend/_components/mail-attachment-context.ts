import { listCapabilityCatalog } from "@k2b/cloud/capabilities";
import {
  type CapabilityCatalog,
  capabilityContractIssues,
  CloudResourceRefSchema,
  contactDirectory,
  FILE_PROVIDER_CONTEXT_MAX_REFS,
  type FileProviderContext,
} from "@k2b/cloud/contracts";
import { type ContactDirectoryTarget, MAIL_CONTACT_DIRECTORY_DEFAULTS } from "../../contact-directory";
import type { MailAddress } from "../../contracts";
import { resolveContacts } from "./contact-capabilities";
import { mailAssistantRecipientEmails } from "./mail-assistant-launch";

type CatalogApp = CapabilityCatalog["apps"][number];

const targetFor = (app: CatalogApp, directory: ContactDirectoryTarget | null): ContactDirectoryTarget | null => {
  const compatible = app.manifest.queries.filter(
    (operation) => capabilityContractIssues(contactDirectory.resolve, { kind: "query", operation }).length === 0,
  );
  const mapped =
    directory && directory.appId === app.appId ? compatible.find((query) => query.localId === directory.capabilityId) : undefined;
  const selected =
    mapped ??
    compatible.find((query) => query.localId === MAIL_CONTACT_DIRECTORY_DEFAULTS.resolve) ??
    (compatible.length === 1 ? compatible[0] : undefined);
  return selected ? { appId: app.appId, capabilityId: selected.localId } : null;
};

/** Resolve hints across visible contact apps. No contact lookup grants access to files. */
export const resolveAttachmentContext = async (
  input: { directory: ContactDirectoryTarget | null; recipients: readonly MailAddress[]; signal: AbortSignal },
  deps: {
    listCatalog?: typeof listCapabilityCatalog;
    resolve?: typeof resolveContacts;
    timeout?: () => AbortSignal;
    catalogTimeout?: () => AbortSignal;
  } = {},
): Promise<FileProviderContext> => {
  const { directory, signal } = input;
  signal.throwIfAborted();
  const emails = mailAssistantRecipientEmails(input.recipients);
  if (emails.length === 0) return { refs: [] };
  const listCatalog = deps.listCatalog ?? listCapabilityCatalog;
  const resolve = deps.resolve ?? resolveContacts;
  let targets: ContactDirectoryTarget[];
  try {
    const catalogSignal = AbortSignal.any([signal, deps.catalogTimeout?.() ?? AbortSignal.timeout(5_000)]);
    const apps: CatalogApp[] = [];
    let cursor: string | undefined;
    do {
      catalogSignal.throwIfAborted();
      const result = await listCatalog({ limit: 25, cursor, signal: catalogSignal });
      catalogSignal.throwIfAborted();
      if (!result.ok) throw new Error(result.error.message);
      apps.push(...result.data.apps);
      const next = result.data.page.hasMore ? result.data.page.nextCursor : undefined;
      if (next && cursor && next <= cursor) throw new Error("Invalid catalog cursor");
      cursor = next;
    } while (cursor);
    targets = apps.flatMap((app) => {
      // A manifest from another release must not suppress the other contact apps.
      try {
        const target = targetFor(app, directory);
        return target ? [target] : [];
      } catch {
        return [];
      }
    });
    targets = [
      ...targets.filter((target) => target.appId === directory?.appId),
      ...targets.filter((target) => target.appId !== directory?.appId),
    ];
  } catch {
    signal.throwIfAborted();
    if (!directory) throw new Error("Could not discover contact apps");
    targets = [directory];
  }

  const results: Awaited<ReturnType<typeof resolveContacts>>["data"]["items"][] = new Array(targets.length);
  let index = 0;
  const worker = async () => {
    while (index < targets.length) {
      signal.throwIfAborted();
      const current = index++;
      // Contact hints must not hold up the chooser.
      const bounded = AbortSignal.any([signal, deps.timeout?.() ?? AbortSignal.timeout(5_000)]);
      try {
        const result = await resolve(targets[current]!, { emails, limit: 50 }, bounded);
        if (!bounded.aborted) results[current] = result.data.items;
      } catch {
        signal.throwIfAborted();
        // A failing, slow, or refusing provider contributes no hints.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker));
  signal.throwIfAborted();
  if (targets.length > 0 && !results.some((items) => items !== undefined)) throw new Error("No contact app answered");
  const refs: FileProviderContext["refs"] = [];
  const seen = new Set<string>();
  for (const email of emails) {
    for (const items of results) {
      for (const item of items ?? []) {
        if (!item.matchedEmails.some((matched) => matched.trim().toLowerCase() === email)) continue;
        const parsed = CloudResourceRefSchema.safeParse(item.ref);
        if (!parsed.success) continue;
        const key = JSON.stringify([parsed.data.type, parsed.data.id]);
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push(parsed.data);
        if (refs.length === FILE_PROVIDER_CONTEXT_MAX_REFS) return { refs };
      }
    }
  }
  return { refs };
};
