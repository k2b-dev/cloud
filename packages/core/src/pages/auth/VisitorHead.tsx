import { Band, Bar, RecordHead, Text } from "@k2b/ui/v2";
import { Show } from "solid-js";

/**
 * The top of a visitor page in Core (sign-in, consent, password): the page's heading beside the installation's logo
 * in the column's head, then the installation's name and the page's sentence. The heading is the document's `h1`.
 */
export function VisitorHead(props: { appName: string; title: string; description?: string | null }) {
  return (
    <>
      <Bar start={<RecordHead name={props.title} avatar={{ name: props.appName, image: "/branding/logo" }} />} />
      <Band>
        <Text weight="strong">{props.appName}</Text>
        <Show when={props.description}>{(description) => <Text muted>{description()}</Text>}</Show>
      </Band>
    </>
  );
}
