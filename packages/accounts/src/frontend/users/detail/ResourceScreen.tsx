import { Bar, Facts, Pane, RecordHead, Section, Workspace } from "@k2b/ui/v2";
import AccountsNav from "../../AccountsNav";
import ApiKeysSection from "../../service-accounts/ApiKeysSection";
import type { KeyPage } from "../../service-accounts/account-keys";
import { useUserRecordMessages } from "./messages";

/**
 * Where an app's own account (`cloud.app`) has its rotating keys managed: the app's keys in Verwaltung › Apps. Revoking
 * one switches the whole app off, so the record shows them read-only and leads there.
 */
const appKeysHref = (account: ResourceAccountView): string | undefined =>
  account.resourceType === "cloud.app" && account.appId
    ? `/admin/apps?${new URLSearchParams({ app: account.appId, view: "keys" })}`
    : undefined;

/** An API key account of an app's resource (a `resource_bound` service account), as the record shows it. */
export type ResourceAccountView = {
  id: string;
  name: string;
  active: boolean;
  appId: string | null;
  resourceType: string | null;
  resourceId: string | null;
};

type Props = {
  account: ResourceAccountView;
  /** The first page of the account's API keys, as `firstKeyPage` read it; null when it could not be read. */
  keys: KeyPage | null;
  modelsAvailable: boolean;
  timeZone: string;
  pendingRequests: number;
};

/**
 * The API key kind of the account record: an app's resource holds keys under its own account. The head names the
 * account with its app and resource; the record shows only its keys, the one thing an administrator does here.
 */
export default function ResourceScreen(props: Props) {
  const r = useUserRecordMessages();
  return (
    <Workspace
      sidebar={<AccountsNav active="users" pendingRequests={props.pendingRequests} />}
      head={
        <Bar
          start={
            // k2b-ui gap: RecordHead takes a person's avatar, no Mark for a thing such as an app's key account
            <RecordHead
              name={props.account.name}
              kinds={[r().resourceKind]}
              ids={[
                ...(props.account.appId ? [{ label: r().app, value: props.account.appId }] : []),
                ...(props.account.resourceType && props.account.resourceId
                  ? [{ label: props.account.resourceType, value: props.account.resourceId, copy: true }]
                  : []),
              ]}
            />
          }
        />
      }
    >
      <Pane.Split>
        <Pane label={r().resourceKind} scrollKey="accounts-resource-record">
          <ApiKeysSection
            account={{
              kind: "resource",
              id: props.account.id,
              name: props.account.name,
              active: props.account.active,
              managedAt: appKeysHref(props.account),
            }}
            first={props.keys}
            modelsAvailable={props.modelsAvailable}
            timeZone={props.timeZone}
          />
        </Pane>
        <Pane side label={r().details} width={{ min: 280, default: 340 }}>
          <Section icon="apps" title={r().resourceOf}>
            <Facts
              items={[
                { label: r().app, value: props.account.appId ?? "–", mono: Boolean(props.account.appId) },
                { label: r().resourceType, value: props.account.resourceType ?? "–" },
                {
                  label: r().resource,
                  value: props.account.resourceId ?? "–",
                  mono: Boolean(props.account.resourceId),
                  copy: props.account.resourceId ?? undefined,
                },
              ]}
            />
          </Section>
        </Pane>
      </Pane.Split>
    </Workspace>
  );
}
