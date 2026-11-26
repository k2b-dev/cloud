import type { AuthContext } from "@k2b/cloud/server";
import { MinimalLayout, type MinimalLayoutProps } from "@k2b/cloud/ssr";
import { Bar, Inline, Mark, type MarkProps, Pane, RecordHead, Workspace } from "@k2b/ui/v2";
import type { JSX } from "solid-js";
import { SignedIn } from "./AuthorizationParts";

/**
 * The page around every OAuth decision a person sees, on UI v2: no rail and no app navigation, one workspace whose
 * head names what the page is about (the page's heading; on a decision the asking application with its mark) and one
 * pane. `title` is the tab's title and, without `heading`, the heading too. `person` adds who is signed in after the
 * content; a decision places them itself, before its buttons.
 */
export function AuthorizationPage(props: {
  c: MinimalLayoutProps["c"];
  title: string;
  heading?: string;
  /** The mark of the asking application, before its name in the head. */
  mark?: MarkProps;
  /** Quiet kinds after the name, such as "Nicht geprüft". */
  kinds?: readonly string[];
  /** The signed-in person (`signedInName`), shown after the content. */
  person?: string;
  children: JSX.Element;
}) {
  props.c.get("page").title = props.title;
  return (
    <MinimalLayout c={props.c} ui="v2" measure>
      <Workspace
        head={
          <Bar
            start={
              props.mark ? (
                <Inline>
                  <Mark {...props.mark} />
                  <RecordHead name={props.heading ?? props.title} kinds={props.kinds} />
                </Inline>
              ) : (
                <RecordHead name={props.heading ?? props.title} kinds={props.kinds} />
              )
            }
          />
        }
      >
        <Pane label={props.heading ?? props.title}>
          {props.children}
          {props.person ? <SignedIn person={props.person} /> : null}
        </Pane>
      </Workspace>
    </MinimalLayout>
  );
}

/** The name a decision page shows for the signed-in person; nothing for a visitor who is not signed in. */
export const signedInName = (actor: AuthContext["Variables"]["actor"] | undefined): string | undefined =>
  actor?.kind === "user" ? actor.user.displayName || actor.user.uid : undefined;
