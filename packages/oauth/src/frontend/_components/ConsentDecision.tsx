import { DescriptionList, useLocale } from "@k2b/ui";
import { oauthMessages } from "../messages";
import { CautionNote, DecisionForm, DecisionHeader, RequestedAccess } from "./AuthorizationParts";

export type ConsentDecisionView = {
  request: string;
  client: { name: string; clientId: string };
  resource: string;
  redirectHost: string;
  scopes: readonly string[];
};

/** The content of the consent card for one dynamically registered client. */
export function ConsentDecision(props: { view: ConsentDecisionView }) {
  const locale = useLocale();
  const t = () => oauthMessages.resolve([locale()]).t;
  const value = (text: string) => <span class="break-all font-mono">{text}</span>;

  return (
    <>
      <DecisionHeader title={t().authorize({ name: props.view.client.name })} />
      <div class="mt-6">
        <DescriptionList
          layout="compact"
          items={[
            { term: t().returnsTo, description: value(props.view.redirectHost) },
            { term: t().resource, description: value(props.view.resource) },
            { term: t().clientId, description: value(props.view.client.clientId) },
          ]}
        />
      </div>
      <RequestedAccess scopes={props.view.scopes} />
      <CautionNote>{t().unverifiedDynamic}</CautionNote>
      <DecisionForm action="/oauth/consent" request={props.view.request} />
    </>
  );
}
