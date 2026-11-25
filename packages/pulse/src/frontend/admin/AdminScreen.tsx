import AdminWorkspace from "@k2b/cloud/ssr/AdminWorkspace";
import { useLocale } from "@k2b/ui";
import { Bar, Button, type NavProps, Text } from "@k2b/ui/v2";
import { createMemo, createSignal, Match, Switch } from "solid-js";
import type { AdminBasesPage, InternalTargetsPage, PulsePolicy } from "../../store/admin-contracts";
import type { StoreConfig } from "../../store/contracts";
import BasesView from "./BasesView";
import { pulseAdminMessages } from "./pulse-admin-messages";
import StoreView from "./StoreView";
import TargetsView from "./TargetsView";

export const ADMIN_VIEWS = ["store", "bases", "targets"] as const;
export type AdminView = (typeof ADMIN_VIEWS)[number];

export type AdminScreenProps = {
  /** The admin bar as the server built it, with Pulse's sections one level in. */
  nav: NavProps;
  view: AdminView;
  store: StoreConfig | null;
  policy: PulsePolicy | null;
  bases: AdminBasesPage | null;
  targets: InternalTargetsPage | null;
};

/** Pulse in the administration on v2: the data store, the bases and the internal targets, each a section of its own. */
export default function AdminScreen(props: AdminScreenProps) {
  const locale = useLocale();
  const t = createMemo(() => pulseAdminMessages.resolve([locale()]).t);
  const [adding, setAdding] = createSignal(false);
  const title = () => ({ store: t().tabStore, bases: t().tabBases, targets: t().tabTargets })[props.view];
  const add = { label: t().addTarget, icon: "plus", onClick: () => setAdding(true) };
  return (
    <AdminWorkspace
      nav={props.nav}
      head={
        <Bar
          start={<Text type="body">{`${t().pageTitle} · ${title()}`}</Text>}
          end={
            props.view === "targets" ? (
              <Button variant="primary" icon="plus" onClick={add.onClick}>
                {add.label}
              </Button>
            ) : undefined
          }
        />
      }
      primary={props.view === "targets" ? add : undefined}
    >
      <Switch>
        <Match when={props.view === "store" && props.store}>{(store) => <StoreView label={title()} initial={store()} />}</Match>
        <Match when={props.view === "bases"}>
          <BasesView label={title()} initialPolicy={props.policy} initialPage={props.bases} />
        </Match>
        <Match when={props.view === "targets"}>
          <TargetsView label={title()} initialPage={props.targets} adding={adding()} setAdding={setAdding} />
        </Match>
      </Switch>
    </AdminWorkspace>
  );
}
