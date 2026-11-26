import { useLocale } from "@k2b/ui";
import { Facts } from "@k2b/ui/v2";
import { oauthMessages } from "../messages";
import { CautionNote, DecisionForm, Parties, RequestedAccess } from "./AuthorizationParts";

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
      {/* who asks and who decides, then what is asked, then the technical facts */}
      <Parties
        app={props.view.client.name}
        kind={props.view.firstParty ? "first_party" : "dynamic"}
        detail={props.view.firstParty ? t().firstParty : t().dynamic}
      />
      <RequestedAccess scopes={props.view.scopes} />
      <Facts
        items={[
          { label: t().returnsTo, value: props.view.redirectHost, mono: true },
          ...(props.view.resource ? [{ label: t().resource, value: props.view.resource, mono: true }] : []),
          { label: t().clientId, value: props.view.client.clientId, mono: true },
        ]}
      />
      <CautionNote
        text={props.view.firstParty ? t().firstPartyOwnRequest : t().unverifiedDynamic}
        reauthenticate={!!props.view.reauthenticateHref}
      />
      <DecisionForm action="/oauth/consent" request={props.view.request} reauthenticateHref={props.view.reauthenticateHref} />
    </>
  );
}
