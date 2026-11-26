import { useLocale } from "@k2b/ui";
import { Band, Bar, Button, Icon, List, Row, Section, Text } from "@k2b/ui/v2";
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
export function RequestedAccess(props: { scopes: readonly string[] }) {
  const t = useMessages();
  return (
    <Section icon="key" title={t().requestedAccess}>
      <For each={props.scopes}>{(scope) => <Row icon={scopeIcons[scope] ?? "check"} lines={[consentScopeLabel(scope, t())]} />}</For>
      <Text type="meta" muted>
        {t().permissionLimit}
      </Text>
    </Section>
  );
}

/**
 * The one caution the person reads right before deciding; when the browser sign-in is too old for access that stays
 * signed in, why they sign in again follows in the same notice.
 */
export function CautionNote(props: { text: string; reauthenticate?: boolean }) {
  const t = useMessages();
  // a quiet line with its sign, right before the buttons
  return (
    <Band>
      <Text>
        <Icon name="alert-triangle" tone="warn" /> {props.reauthenticate ? `${props.text} ${t().confirmIdentityHint}` : props.text}
      </Text>
    </Band>
  );
}

/** Who asks: the requesting application with the sign of its kind and where it returns to. */
export function Parties(props: { app: string; kind: "first_party" | "dynamic" | "managed"; detail: string }) {
  const t = useMessages();
  return (
    <List label={t().parties}>
      <Row
        icon={props.kind === "first_party" ? "cloud" : props.kind === "dynamic" ? "world" : "key"}
        color={props.kind === "first_party" ? "var(--k2-app, var(--k2-blue))" : props.kind === "dynamic" ? "var(--k2-warn)" : "var(--k2-ok)"}
        lines={[props.app, props.detail]}
      />
    </List>
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
export function DecisionForm(props: { action: string; request: string; userCode?: string; reauthenticateHref?: string | null }) {
  const t = useMessages();
  return (
    <>
      <form id={DECISION_FORM} method="post" action={props.action} hidden>
        <input type="hidden" name="request" value={props.request} />
        {props.userCode ? <input type="hidden" name="user_code" value={props.userCode} /> : null}
      </form>
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
    </>
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
