import { type CloudCliCandidate, cliAmbiguityText, localizeCloudCliText } from "@k2b/cloud/cli";
import type { PermissionLevel } from "@k2b/cloud/contracts";
import { fail, ok, type Result } from "@k2b/stdlib";
import type { Mailbox } from "../contracts";
import { mailFolderPaths } from "../folder-tree";
import { getMailboxPermission } from "./access";
import type { MailRequestContext } from "./auth";
import { getMailbox, listMailboxes } from "./mailboxes";
import { listFolders, type MailFolderView } from "./messages";
import { publicIds, resolvePublicId } from "./public-resources";

const SHORT_ID = /^[0-9A-Za-z]{6}$/;

/** A folder with its display path, such as `Projekte / 2025 / Archiv`. */
export type MailAddressFolder = MailFolderView & { path: string };

/** The mailbox with the caller's effective permission. */
export type MailAddressMailbox = Mailbox & { permission: PermissionLevel };

export type MailAddressResolution = { mailbox: MailAddressMailbox; folder: MailAddressFolder | null };

/** `Projekte/2025 /Archiv` and `Projekte / 2025 / Archiv` name the same folder. */
export const normalizeMailFolderPath = (value: string): string =>
  value
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(" / ");

/**
 * Every folder a reference can mean: its public ID, or its path compared
 * case-insensitively (IMAP treats `INBOX` case-insensitively; everything else
 * that differs only in case is reported as ambiguous instead of guessed).
 */
export const matchMailFolders = <T extends { publicId: string; path: string }>(folders: readonly T[], ref: string): T[] => {
  const wanted = normalizeMailFolderPath(ref).toLowerCase();
  return folders.filter(
    (folder) => folder.publicId === ref || (wanted !== "" && normalizeMailFolderPath(folder.path).toLowerCase() === wanted),
  );
};

const conflict = (locale: string | undefined, value: string, resources: { en: string; de: string }, candidates: CloudCliCandidate[]) =>
  fail({
    code: "CONFLICT" as const,
    status: 409 as const,
    message: localizeCloudCliText(locale, cliAmbiguityText({ value, resources, candidates })),
  });

const notFound = (locale: string | undefined, text: { en: string; de: string }) =>
  fail({ code: "NOT_FOUND" as const, status: 404 as const, message: localizeCloudCliText(locale, text) });

const resolveMailbox = async (
  context: MailRequestContext,
  ref: string,
  locale: string | undefined,
): Promise<Result<MailAddressMailbox>> => {
  const internalId = SHORT_ID.test(ref) ? await resolvePublicId("mailboxes", ref) : null;
  const [byId, byName] = await Promise.all([
    internalId ? getMailbox(context, internalId) : Promise.resolve(null),
    listMailboxes(context, 200, ref),
  ]);
  if (!byName.ok) return byName;
  const candidates = new Map<string, Mailbox>();
  if (byId?.ok) candidates.set(byId.data.id, byId.data);
  for (const mailbox of byName.data) candidates.set(mailbox.id, mailbox);
  const matches = [...candidates.values()];
  const [match] = matches;
  if (match && matches.length === 1) {
    // Name matches carry list-only fields; read the mailbox itself so both forms answer with one shape.
    const mailbox = byId?.ok && byId.data.id === match.id ? byId : await getMailbox(context, match.id);
    if (!mailbox.ok) return mailbox;
    return ok({ ...mailbox.data, permission: await getMailboxPermission(context, match.id) });
  }
  if (matches.length === 0)
    return notFound(locale, { en: `No mailbox is named "${ref}" or has that ID.`, de: `Kein Postfach heißt „${ref}“ oder hat diese ID.` });
  const ids = await publicIds(
    "mailboxes",
    matches.map((mailbox) => mailbox.id),
  );
  return conflict(
    locale,
    ref,
    { en: "mailboxes", de: "Postfächern" },
    matches.map((mailbox) => ({ path: mailbox.name, id: ids.get(mailbox.id) ?? mailbox.id })),
  );
};

const resolveFolder = async (
  context: MailRequestContext,
  mailbox: Mailbox,
  ref: string,
  locale: string | undefined,
): Promise<Result<MailAddressFolder>> => {
  const folders = await listFolders(context, mailbox.id);
  if (!folders.ok) return folders;
  const paths = mailFolderPaths(folders.data);
  const ids = await publicIds(
    "folders",
    folders.data.map((folder) => folder.id),
  );
  const matches = matchMailFolders(
    folders.data.map((folder) => ({ folder, publicId: ids.get(folder.id) ?? "", path: paths.get(folder.id) ?? folder.name })),
    ref,
  );
  if (matches.length === 1) return ok({ ...matches[0]!.folder, path: matches[0]!.path });
  if (matches.length === 0)
    return notFound(locale, {
      en: `Mailbox "${mailbox.name}" has no folder "${ref}". List its folders with \`cld mail folders\`.`,
      de: `Das Postfach „${mailbox.name}“ hat keinen Ordner „${ref}“. Seine Ordner zeigt \`cld mail folders\`.`,
    });
  return conflict(
    locale,
    ref,
    { en: "folders", de: "Ordnern" },
    matches.map((match) => ({ path: match.path, id: match.publicId })),
  );
};

/** Resolve a CLI mailbox reference and an optional folder reference inside it. */
export const resolveMailAddress = async (params: {
  context: MailRequestContext;
  mailbox: string;
  folder?: string;
  locale?: string;
}): Promise<Result<MailAddressResolution>> => {
  const mailbox = await resolveMailbox(params.context, params.mailbox.trim(), params.locale);
  if (!mailbox.ok) return mailbox;
  if (params.folder === undefined) return ok({ mailbox: mailbox.data, folder: null });
  const folder = await resolveFolder(params.context, mailbox.data, params.folder, params.locale);
  return folder.ok ? ok({ mailbox: mailbox.data, folder: folder.data }) : folder;
};
