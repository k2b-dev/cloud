import { MinimalLayout, type MinimalLayoutProps } from "@k2b/cloud/ssr";
import { Band, Bar, Pane, RecordHead, Text, Workspace } from "@k2b/ui/v2";
import { type JSX, Show } from "solid-js";

/**
 * A visitor page of Core (sign-in, password, consent, a legal text) on v2: one task in `MinimalLayout measure`, as the
 * OAuth pages are. The head holds the page's heading (the document's `h1`) beside the installation's logo; with a
 * sentence, the installation's name and the sentence lead the column.
 */
export function VisitorPage(props: {
  c: MinimalLayoutProps["c"];
  appName: string;
  title: string;
  description?: string | null;
  children: JSX.Element;
}) {
  return (
    <MinimalLayout c={props.c} ui="v2" measure>
      <Workspace head={<Bar start={<RecordHead name={props.title} avatar={{ name: props.appName, image: "/branding/logo" }} />} />}>
        <Pane label={props.title}>
          <Show when={props.description}>
            {(description) => (
              <Band>
                <Text weight="strong">{props.appName}</Text>
                <Text muted>{description()}</Text>
              </Band>
            )}
          </Show>
          {props.children}
        </Pane>
      </Workspace>
    </MinimalLayout>
  );
}
