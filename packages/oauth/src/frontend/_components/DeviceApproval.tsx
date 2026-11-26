import { useLocale } from "@k2b/ui";
import { Canvas, Section, Text } from "@k2b/ui/v2";
import { Match, Switch } from "solid-js";
import { oauthMessages } from "../messages";
import { DecisionForm, Outcome, RequestedAccess, SignedIn } from "./AuthorizationParts";
import { DeviceCodeDrawing } from "./DeviceCodeDrawing";
import DeviceCodeForm from "./DeviceCodeForm.island";

type DeviceOutcome = "approved" | "denied" | "expired" | "blocked";

export type DeviceApprovalView =
  | { kind: "entry"; code?: string; error?: string }
  | {
      kind: "confirm";
      request: string;
      code: string;
      client: { name: string; clientId: string; kind: "first_party" | "dynamic" | "managed" };
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
export function DeviceApproval(props: { view: DeviceApprovalView; person?: string }) {
  const locale = useLocale();
  const t = () => oauthMessages.resolve([locale()]).t;

  return (
    <Switch>
      <Match when={props.view.kind === "entry" && props.view}>
        {(view) => (
          <>
            <DeviceCodeForm hint={t().deviceEnterCode} code={view().code} error={view().error} />
          </>
        )}
      </Match>
      <Match when={props.view.kind === "confirm" && props.view}>
        {(view) => (
          <>
            {/* the head names the asking application; first the code to compare, then what it asks for, for whom,
                and the decision, in one rhythm of sections */}
            <Section icon="device-desktop" title={t().compareCodeTitle}>
              <Text>{t().deviceConfirmCode}</Text>
              {/* comparing the code with the terminal is what keeps a person from approving someone else's sign-in */}
              <Canvas label={t().deviceCodeLabel}>
                <DeviceCodeDrawing code={view().code} />
              </Canvas>
            </Section>
            <RequestedAccess scopes={view().scopes} limitNote />
            {props.person ? <SignedIn person={props.person} /> : null}
            <DecisionForm
              action="/oauth/device"
              request={view().request}
              userCode={view().code}
              reauthenticateHref={view().reauthenticateHref}
              caution={t().deviceOwnCodeWarning}
            />
          </>
        )}
      </Match>
      <Match when={props.view.kind === "result" && props.view}>
        {(view) => (
          <Switch>
            <Match when={view().outcome === "approved"}>
              <Outcome icon="circle-check" ok body={view().message ?? t().deviceApprovedBody} />
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
