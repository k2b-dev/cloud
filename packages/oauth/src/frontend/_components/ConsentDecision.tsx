import { useLocale } from "@k2b/ui";
import { oauthMessages } from "../messages";
import { DecisionForm, RequestedAccess, SignedIn, TechnicalFacts } from "./AuthorizationParts";

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
 * The consent for a dynamically registered client or the first-party command line. The head names the application
 * with its mark; below, in one rhythm: what it asks for, for which account, the technical facts folded, the decision.
 */
export function ConsentDecision(props: { view: ConsentDecisionView; person?: string }) {
  const locale = useLocale();
  const t = () => oauthMessages.resolve([locale()]).t;

  return (
    <>
      <RequestedAccess scopes={props.view.scopes} />
      {props.person ? <SignedIn person={props.person} /> : null}
      <TechnicalFacts
        items={[
          { label: t().returnsTo, value: props.view.redirectHost, mono: true },
          ...(props.view.resource ? [{ label: t().resource, value: props.view.resource, mono: true }] : []),
          { label: t().clientId, value: props.view.client.clientId, mono: true },
        ]}
      />
      <DecisionForm
        action="/oauth/consent"
        request={props.view.request}
        reauthenticateHref={props.view.reauthenticateHref}
        caution={props.view.firstParty ? t().firstPartyOwnRequest : t().unverifiedDynamic}
      />
    </>
  );
}
