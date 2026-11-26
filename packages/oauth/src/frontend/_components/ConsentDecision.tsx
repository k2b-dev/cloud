import { useLocale } from "@k2b/ui";
import { Facts } from "@k2b/ui/v2";
import { oauthMessages } from "../messages";
import { CautionNote, DecisionForm, RequestedAccess } from "./AuthorizationParts";

export type ConsentDecisionView = {
  request: string;
  client: { name: string; clientId: string };
  firstParty: boolean;
  reauthenticateHref: string | null;
  resource: string | null;
  redirectHost: string;
  scopes: readonly string[];
};

/**
 * The consent for a dynamically registered client or the first-party command line. The client names itself, so its
 * whole name stands in the facts, where it wraps; the head never cuts it.
 */
export function ConsentDecision(props: { view: ConsentDecisionView }) {
  const locale = useLocale();
  const t = () => oauthMessages.resolve([locale()]).t;

  return (
    <>
      <Facts
        items={[
          { label: t().application, value: props.view.client.name },
          { label: t().returnsTo, value: props.view.redirectHost, mono: true },
          ...(props.view.resource ? [{ label: t().resource, value: props.view.resource, mono: true }] : []),
          { label: t().clientId, value: props.view.client.clientId, mono: true },
        ]}
      />
      <RequestedAccess scopes={props.view.scopes} />
      <CautionNote
        text={props.view.firstParty ? t().firstPartyOwnRequest : t().unverifiedDynamic}
        reauthenticate={!!props.view.reauthenticateHref}
      />
      <DecisionForm action="/oauth/consent" request={props.view.request} reauthenticateHref={props.view.reauthenticateHref} />
    </>
  );
}
