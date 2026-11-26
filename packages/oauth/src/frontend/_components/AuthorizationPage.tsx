import { MinimalLayout, type MinimalLayoutProps } from "@k2b/cloud/ssr";
import { Bar, Pane, RecordHead, Workspace } from "@k2b/ui/v2";
import type { JSX } from "solid-js";

/**
 * The page around every OAuth decision a person sees, on UI v2: no rail and no app navigation, one workspace whose
 * head names the task (the page's heading) and one pane with the decision. `title` is the tab's title and, without
 * `heading`, the heading too.
 */
export function AuthorizationPage(props: { c: MinimalLayoutProps["c"]; title: string; heading?: string; children: JSX.Element }) {
  props.c.get("page").title = props.title;
  return (
    <MinimalLayout c={props.c} ui="v2">
      <Workspace head={<Bar start={<RecordHead name={props.heading ?? props.title} />} />}>
        <Pane label={props.heading ?? props.title}>{props.children}</Pane>
      </Workspace>
    </MinimalLayout>
  );
}
