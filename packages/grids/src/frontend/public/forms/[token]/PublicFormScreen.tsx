import { Bar, Canvas, Empty, Pane, RecordHead, Workspace } from "@k2b/ui/v2";
import type { ComponentProps } from "solid-js";
import PublicFormSubmit from "../../../_components/forms/PublicFormSubmit.island";

/**
 * A shared form for a visitor (recipe `public-page`): its title in the head, the form under it. The fields stay the
 * shared v1 form renderer (in-app forms use it too) inside a Canvas until the form controls are rebuilt on v2.
 */
export function PublicFormScreen(props: ComponentProps<typeof PublicFormSubmit>) {
  const title = () => props.form.config.title ?? props.form.name;
  return (
    <Workspace head={<Bar start={<RecordHead name={title()} />} />}>
      <Pane label={title()}>
        <Canvas label={title()}>
          {/* the v1 form keeps the text edge of the page: 20 px, 16 px on a phone (textEdge) */}
          <div class="p-4 md:p-5">
            <PublicFormSubmit {...props} showTitle={false} />
          </div>
        </Canvas>
      </Pane>
    </Workspace>
  );
}

/** A form link that no longer opens a form: one sentence, no form. */
export function PublicFormUnavailable(props: { title: string; text: string }) {
  return (
    <Workspace head={<Bar start={<RecordHead name={props.title} />} />}>
      <Pane label={props.title}>
        <Empty icon="forms" text={props.text} />
      </Pane>
    </Workspace>
  );
}
