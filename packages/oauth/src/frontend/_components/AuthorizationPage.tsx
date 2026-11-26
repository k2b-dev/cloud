import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { MinimalLayout, type MinimalLayoutProps } from "@k2b/cloud/ssr";
import { Bar, List, Pane, RecordHead, Row, Workspace } from "@k2b/ui/v2";
import type { JSX } from "solid-js";
import { oauthMessages } from "../messages";

/**
 * The page around every OAuth decision a person sees, on UI v2: no rail and no app navigation, one workspace whose
 * head names the task (the page's heading) and one pane with the decision. `title` is the tab's title and, without
 * `heading`, the heading too.
 */
export function AuthorizationPage(props: {
  c: MinimalLayoutProps["c"];
  title: string;
  heading?: string;
  /** The signed-in person who decides here (`signedInName`); the page names them first, with their picture. */
  person?: string;
  children: JSX.Element;
}) {
  props.c.get("page").title = props.title;
  const { t } = oauthMessages.resolve([getLocale(props.c)]);
  const person = props.person;
  return (
    <MinimalLayout c={props.c} ui="v2" measure>
      <Workspace head={<Bar start={<RecordHead name={props.heading ?? props.title} />} />}>
        <Pane label={props.heading ?? props.title}>
          {/* who decides here, with their picture, first on every width */}
          {person ? (
            <List label={t.signedInAs({ name: person })}>
              <Row avatar={{ name: person }} lines={[t.signedInAs({ name: person })]} />
            </List>
          ) : null}
          {props.children}
        </Pane>
      </Workspace>
    </MinimalLayout>
  );
}

/** The name a decision page shows for the signed-in person; nothing for a visitor who is not signed in. */
export const signedInName = (actor: AuthContext["Variables"]["actor"] | undefined): string | undefined =>
  actor?.kind === "user" ? actor.user.displayName || actor.user.uid : undefined;
