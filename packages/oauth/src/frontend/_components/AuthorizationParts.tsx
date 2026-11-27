import { useLocale } from "@k2b/ui";
import { Avatar, Band, Bar, Button, Facts, type FactsProps, Icon, Inline, Row, Section, Text } from "@k2b/ui/v2";
import { For } from "solid-js";
import { oauthMessages } from "../messages";
import { consentScopeLabel } from "../scope-labels";

const useMessages = () => {
  const locale = useLocale();
  return () => oauthMessages.resolve([locale()]).t;
};

/** The sign of each scope, as the client editor shows it. */
const scopeIcons: Record<string, string> = {
  openid: "fingerprint",
  profile: "id-badge-2",
  email: "mail",
  groups: "users-group",
  offline_access: "refresh",
  read: "eye",
  write: "pencil",
  admin: "shield-lock",
};

/** Every requested scope in words, and the reminder that Cloud permissions still apply. */
export function RequestedAccess(props: { scopes: readonly string[]; limitNote?: boolean }) {
  const t = useMessages();
  return (
    <Section title={t().requestedAccess} summary={props.limitNote ? t().permissionLimit : undefined}>
      <For each={props.scopes}>{(scope) => <Row icon={scopeIcons[scope] ?? "check"} lines={[consentScopeLabel(scope, t())]} />}</For>
    </Section>
  );
}

/** Who is signed in here: the account the decision is for, with its picture. */
export function SignedIn(props: { person: string }) {
  const t = useMessages();
  return (
    <Section title={t().forAccount}>
      <Row avatar={{ name: props.person }} lines={[props.person, t().signedInHere]} />
    </Section>
  );
}

/**
 * The technical facts of a request, quiet, after the decision's content: the person rarely needs them, an
 * administrator finds them. They stand open, since a decision page works without script.
 */
export function TechnicalFacts(props: { items: FactsProps["items"] }) {
  const t = useMessages();
  return (
    <Section title={t().technicalDetails} summary={t().permissionLimit}>
      <Facts items={props.items} />
    </Section>
  );
}

/** The `id` of the one decision form on a page; its buttons stand in a bar and send it by this name. */
const DECISION_FORM = "oauth-decision";

/**
 * Deny and Allow in one row, Allow last and primary; the row keeps its order on phones, so the reading and focus order
 * stay the same. The form is the server's: a POST with the request (and the device code) as hidden fields and the
 * pressed button's `decision`. When the browser sign-in is too old for access that stays signed in, "Confirm identity"
 * takes Allow's place and opens the sign-in that leads back to this page; Deny keeps working.
 */
export function DecisionForm(props: {
  action: string;
  request: string;
  userCode?: string;
  reauthenticateHref?: string | null;
  /** The one caution read right before deciding; a too old sign-in adds why the person signs in again. */
  caution: string;
  /** The signed-in person the decision is for, named right above the caution. */
  person?: string;
}) {
  const t = useMessages();
  return (
    <Band>
      <form id={DECISION_FORM} method="post" action={props.action} hidden>
        <input type="hidden" name="request" value={props.request} />
        {props.userCode ? <input type="hidden" name="user_code" value={props.userCode} /> : null}
      </form>
      {props.person ? (
        <Inline>
          <Avatar name={props.person} decorative />
          <Text weight="strong">{props.person}</Text>
          <Text type="meta" muted>
            {t().signedInHere}
          </Text>
        </Inline>
      ) : null}
      <Text>
        <Icon name="alert-triangle" tone="warn" />{" "}
        {props.reauthenticateHref ? `${props.caution} ${t().confirmIdentityHint}` : props.caution}
      </Text>
      <Bar
        end={
          <>
            <Button type="submit" form={DECISION_FORM} name="decision" value="deny">
              {t().deny}
            </Button>
            {props.reauthenticateHref ? (
              <Button variant="primary" icon="shield-lock" href={props.reauthenticateHref}>
                {t().confirmIdentity}
              </Button>
            ) : (
              <Button variant="primary" icon="check" type="submit" form={DECISION_FORM} name="decision" value="approve">
                {t().allowAccess}
              </Button>
            )}
          </>
        }
      />
    </Band>
  );
}

/** The final state of a decision: its sign, one sentence and, where there is one, the way on; read as a status. */
export function Outcome(props: { icon: string; body: string; ok?: boolean; action?: { label: string; href: string } }) {
  // the sign stands in the sentence's line; the way on follows below
  return (
    <Band>
      <Text>
        <Icon name={props.icon} tone={props.ok ? "ok" : "muted"} /> <span role="status">{props.body}</span>
      </Text>
      {props.action ? (
        <Bar
          end={
            <Button icon="arrow-right" href={props.action.href}>
              {props.action.label}
            </Button>
          }
        />
      ) : null}
    </Band>
  );
}
