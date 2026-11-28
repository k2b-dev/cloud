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
    <Workspace>
      <Pane label={title()}>
        {/* k2b-ui slot (#4278 measure): until it lands, the form stands in a centred reading column of 640 px with its
            title, like the shared document */}
        <Canvas label={title()}>
          <div class="mx-auto w-full max-w-[640px] py-6">
            <Bar start={<RecordHead name={title()} />} />
          </div>
          {/* the v1 form keeps the text edge of the page: 20 px, 16 px on a phone (textEdge) */}
          <div class="mx-auto w-full max-w-[640px] px-4 pb-6 md:px-5">
            {/* bare: the v2 page is the frame, so the form draws no card of its own (no box in a box) */}
            <PublicFormSubmit {...props} showTitle={false} surface="bare" />
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
