import type { User } from "@k2b/cloud/contracts";
import { Band, Bar, Button, Chip, Pane, StatusRow, Table, Text, Workspace } from "@k2b/ui/v2";
import { Show } from "solid-js";
import AccountsNav from "../AccountsNav";
import { useListMessages } from "../list-messages";
import { useAccountsMessages } from "../messages";
import DeleteDuplicateUser from "./DeleteDuplicateUser";

/** One account that shares its address with another; times are formatted by the server, in UTC as the page says. */
export type DuplicateRow = {
  email: string;
  user: Pick<User, "id" | "uid" | "mail" | "givenname" | "sn" | "displayName" | "provider" | "profile">;
  name: string;
  category: string;
  web: string;
  kerberos: string;
  sync: string;
  expires: string;
  /** Your own account and FreeIPA accounts while FreeIPA is off cannot be deleted here. */
  deletable: boolean;
  disabledReason?: string;
};

export type DuplicateEmailsScreenProps = {
  /** Every account of the page, those of one address one after the other. */
  rows: DuplicateRow[];
  /** How many addresses are shared in all. */
  total: number;
  page: number;
  pages: number;
  pendingRequests: number;
};

const pageHref = (page: number) => `/app/accounts/duplicate-emails?page=${page}`;

/** Accounts that share an email address on v2: one table grouped by address, each account with its sign-ins and "delete". */
export default function DuplicateEmailsScreen(props: DuplicateEmailsScreenProps) {
  const t = useAccountsMessages();
  const words = useListMessages();
  const count = (email: string) => props.rows.filter((row) => row.email === email).length;
  return (
    <Workspace
      sidebar={<AccountsNav active="duplicate-emails" pendingRequests={props.pendingRequests} />}
      head={<Bar start={<Text type="body">{t().duplicateEmails}</Text>} />}
    >
      <Pane label={t().duplicateEmails} scrollKey="accounts-duplicate-emails" status={<StatusRow lead={t().duplicateEmailsCount({ count: props.total })} />}>
        <Band>
          <Text muted>
            {t().duplicateEmailsDescription} {t().duplicateLoginExplanation}
          </Text>
        </Band>
        <Table
          label={t().duplicateEmails}
          rows={props.rows}
          rowKey={(row) => `${row.email}:${row.user.id}`}
          sticky
          group={(row) => ({
            key: row.email,
            head: () => <Text weight="strong">{row.email}</Text>,
            meta: t().accountCount({ count: count(row.email) }),
            count: String(count(row.email)),
          })}
          open={(row) => ({ href: `/app/accounts/users/${row.user.id}` })}
          empty={{ icon: "copy-check", text: t().duplicateEmailsEmpty }}
          phone={(row) => ({
            lines: [row.name, `${row.user.uid} · ${t().lastWebLogin}: ${row.web}`],
            marks: <Chip>{row.category}</Chip>,
          })}
          columns={[
            {
              title: t().user,
              width: { min: 180, default: 240 },
              cell: (row) => ({ lines: [row.name, [row.user.uid, row.user.mail].filter(Boolean).join(" · ")] }),
            },
            { title: t().accountType, width: { min: 110, default: 130 }, cell: (row) => <Chip>{row.category}</Chip> },
            { title: t().lastWebLogin, width: { min: 140, default: 160 }, cell: (row) => row.web, drop: true },
            { title: t().lastKerberosLogin, width: { min: 140, default: 160 }, cell: (row) => row.kerberos, drop: true },
            { title: t().duplicateLastSync, width: { min: 140, default: 160 }, cell: (row) => row.sync, drop: true },
            { title: t().accountExpires, width: { min: 140, default: 160 }, cell: (row) => row.expires, drop: true },
            {
              title: t().actions,
              width: { min: 80, default: 90 },
              align: "end",
              cell: (row) => <DeleteDuplicateUser user={row.user} disabled={!row.deletable} disabledReason={row.disabledReason} />,
              drop: true,
            },
          ]}
        />
        <Show when={props.pages > 1}>
          <Bar
            start={<Text type="meta">{words().pageOf({ page: props.page, pages: props.pages })}</Text>}
            end={
              <>
                <Button icon="chevron-left" href={pageHref(props.page - 1)} disabled={props.page <= 1}>
                  {words().previous}
                </Button>
                <Button href={pageHref(props.page + 1)} disabled={props.page >= props.pages} forward>
                  {words().next}
                </Button>
              </>
            }
          />
        </Show>
      </Pane>
    </Workspace>
  );
}
