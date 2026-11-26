import { useLocale } from "@k2b/ui";
import { Facts, Text } from "@k2b/ui/v2";
import { Match, Show, Switch } from "solid-js";
import { oauthMessages } from "../messages";
import { CautionNote, DecisionForm, Outcome, ReauthenticateNote, RequestedAccess } from "./AuthorizationParts";
import DeviceCodeForm from "./DeviceCodeForm.island";

type DeviceOutcome = "approved" | "denied" | "expired" | "blocked";

export type DeviceApprovalView =
  | { kind: "entry"; code?: string; error?: string }
  | {
      kind: "confirm";
      request: string;
      code: string;
      client: { name: string; clientId: string };
      scopes: string[];
      reauthenticateHref: string | null;
    }
  | { kind: "result"; outcome: DeviceOutcome; message?: string };

/** The heading of a result, which is also the tab title once the request has an answer. */
export const deviceResultTitle = (outcome: DeviceOutcome, t: ReturnType<typeof oauthMessages.resolve>["t"]): string =>
  ({ approved: t.deviceApprovedTitle, denied: t.deviceDeniedTitle, expired: t.deviceExpiredTitle, blocked: t.authorizationFailed })[
    outcome
  ];

/** The device approval; the server decides which state is shown, and the page's head names it. */
export function DeviceApproval(props: { view: DeviceApprovalView }) {
  const locale = useLocale();
  const t = () => oauthMessages.resolve([locale()]).t;

  return (
    <Switch>
      <Match when={props.view.kind === "entry" && props.view}>
        {(view) => (
          <>
            <Text>{t().deviceEnterCode}</Text>
            <DeviceCodeForm code={view().code} error={view().error} />
          </>
        )}
      </Match>
      <Match when={props.view.kind === "confirm" && props.view}>
        {(view) => (
          <>
            <Text weight="strong">{t().deviceConfirmTitle({ name: view().client.name })}</Text>
            <Text>{t().deviceConfirmCode}</Text>
            <Facts
              items={[
                { label: t().deviceCodeLabel, value: view().code, mono: true },
                { label: t().application, value: view().client.name },
                { label: t().clientId, value: view().client.clientId, mono: true },
              ]}
            />
            <RequestedAccess scopes={view().scopes} />
            <CautionNote>{t().deviceOwnCodeWarning}</CautionNote>
            <Show when={view().reauthenticateHref}>
              <ReauthenticateNote />
            </Show>
            <DecisionForm
              action="/oauth/device"
              request={view().request}
              userCode={view().code}
              reauthenticateHref={view().reauthenticateHref}
            />
          </>
        )}
      </Match>
      <Match when={props.view.kind === "result" && props.view}>
        {(view) => (
          <Switch>
            <Match when={view().outcome === "approved"}>
              <Outcome icon="circle-check" body={t().deviceApprovedBody} />
            </Match>
            <Match when={view().outcome === "denied"}>
              <Outcome icon="circle-x" body={t().deviceDeniedBody} />
            </Match>
            <Match when={view().outcome === "expired"}>
              <Outcome
                icon="clock"
                body={view().message ?? t().deviceExpiredBody}
                action={{ label: t().deviceEnterAnother, href: "/oauth/device" }}
              />
            </Match>
            <Match when={view().outcome === "blocked"}>
              <Outcome icon="lock" body={view().message ?? t().authorizationFailed} />
            </Match>
          </Switch>
        )}
      </Match>
    </Switch>
  );
}
