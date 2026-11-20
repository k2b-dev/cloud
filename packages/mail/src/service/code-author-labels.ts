import { sql } from "@k2b/cloud";
import { codeAccountOwner, codeAccountPresenter } from "@k2b/cloud/server";

/**
 * A Code account's stored name is its technical owner key (`code:mail.mailbox:<id>`). People see the platform's Code
 * label instead: with this mailbox's name for this mailbox's own Code, whose readers already see that name, and the
 * neutral type label ("Code of a mailbox") for any other owner, whose title they may not read. Never the key.
 * Other names map to themselves. No SQL unless a name has the Code key form.
 */
export const codeAuthorLabels = async (params: {
  mailboxId: string;
  locale?: string;
  names: readonly (string | null | undefined)[];
}): Promise<(name: string | null | undefined) => string | null | undefined> => {
  const keys = [...new Set(params.names.filter((name): name is string => !!name && codeAccountOwner(name) !== null))];
  if (keys.length === 0) return (name) => name;
  const accounts = await sql<{ name: string; title: string | null }[]>`
    SELECT account.name, CASE WHEN account.name = 'code:mail.mailbox:' || mailbox.short_id THEN account.title END AS title
    FROM auth.service_accounts account
    JOIN mail.mailboxes mailbox ON mailbox.id = ${params.mailboxId}::uuid
    WHERE account.kind = 'code' AND account.name IN (SELECT jsonb_array_elements_text(${keys}::jsonb))
  `;
  // The title is withheld above for every other owner, so the presenter falls back to the type label.
  const present = codeAccountPresenter({ canManageTarget: true, locale: params.locale });
  const labels = new Map(await Promise.all(accounts.map(async (account) => [account.name, (await present(account)).displayName] as const)));
  return (name) => (name ? (labels.get(name) ?? name) : name);
};
