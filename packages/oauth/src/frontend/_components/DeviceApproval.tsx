import { ButtonLink, DescriptionList, useLocale } from "@k2b/ui";
import { Match, Switch } from "solid-js";
import { oauthMessages } from "../messages";
import { CautionNote, DecisionForm, DecisionHeader, Outcome, RequestedAccess } from "./AuthorizationParts";
import DeviceCodeForm from "./DeviceCodeForm.island";

export type DeviceApprovalView =
  | { kind: "entry"; code?: string; error?: string }
  | { kind: "confirm"; request: string; code: string; client: { name: string; clientId: string }; scopes: string[] }
  | { kind: "result"; outcome: "approved" | "denied" | "expired" | "blocked"; message?: string };

/** The content of the device approval card; the server decides which state is shown. */
export function DeviceApproval(props: { view: DeviceApprovalView }) {
  const locale = useLocale();
  const t = () => oauthMessages.resolve([locale()]).t;

  return (
    <Switch>
      <Match when={props.view.kind === "entry" && props.view}>
        {(view) => (
          <>
            <DecisionHeader title={t().deviceTitle}>{t().deviceEnterCode}</DecisionHeader>
            <div class="mt-6">
              <DeviceCodeForm code={view().code} error={view().error} />
            </div>
          </>
        )}
      </Match>
      <Match when={props.view.kind === "confirm" && props.view}>
        {(view) => (
          <>
            <DecisionHeader title={t().deviceConfirmTitle({ name: view().client.name })} />
            <p class="mt-6 text-sm text-dimmed">{t().deviceConfirmCode}</p>
            <p class="mt-1 font-mono text-3xl font-semibold tracking-[0.12em] text-primary tabular-nums" data-testid="device-user-code">
              {view().code}
            </p>
            <div class="mt-3">
              <DescriptionList
                layout="compact"
                items={[{ term: t().clientId, description: <span class="break-all font-mono">{view().client.clientId}</span> }]}
              />
            </div>
            <RequestedAccess scopes={view().scopes} />
            <CautionNote>{t().deviceOwnCodeWarning}</CautionNote>
            <DecisionForm action="/oauth/device" request={view().request} />
          </>
        )}
      </Match>
      <Match when={props.view.kind === "result" && props.view}>
        {(view) => (
          <Switch>
            <Match when={view().outcome === "approved"}>
              <Outcome icon="ti ti-circle-check" success title={t().deviceApprovedTitle} body={t().deviceApprovedBody} />
            </Match>
            <Match when={view().outcome === "denied"}>
              <Outcome icon="ti ti-circle-x" title={t().deviceDeniedTitle} body={t().deviceDeniedBody} />
            </Match>
            <Match when={view().outcome === "expired"}>
              <Outcome icon="ti ti-clock" title={t().deviceExpiredTitle} body={view().message ?? t().deviceExpiredBody}>
                <ButtonLink href="/oauth/device" variant="secondary" size="lg">
                  {t().deviceEnterAnother}
                </ButtonLink>
              </Outcome>
            </Match>
            <Match when={view().outcome === "blocked"}>
              <Outcome icon="ti ti-lock" title={t().authorizationFailed} body={view().message} />
            </Match>
          </Switch>
        )}
      </Match>
    </Switch>
  );
}
