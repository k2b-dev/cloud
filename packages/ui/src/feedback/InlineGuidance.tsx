import { type JSX, Show, splitProps } from "solid-js";
import type { IntentTone } from "../semantics";

export type InlineGuidanceProps = Omit<JSX.HTMLAttributes<HTMLDivElement>, "children" | "class"> & {
  children: JSX.Element;
  tone?: IntentTone;
  loading?: boolean;
  icon?: string | false;
  class?: string;
};

export function InlineGuidance(props: InlineGuidanceProps): JSX.Element {
  const [local, rest] = splitProps(props, ["children", "tone", "icon", "class", "loading"]);

  const icon = () => local.icon ?? (local.loading ? "ti ti-loader-2" : undefined);

  return (
    <div
      role={local.loading ? "status" : undefined}
      aria-live={local.loading ? "polite" : undefined}
      aria-busy={local.loading ? "true" : undefined}
      {...rest}
      class={local.class ? `k2b-inline-guidance ${local.class}` : "k2b-inline-guidance"}
      data-tone={local.tone ?? "neutral"}
      data-loading={local.loading ? "true" : undefined}
    >
      <Show when={icon()}>{(icon) => <i class={`${icon()} k2b-inline-guidance__icon`} aria-hidden="true" />}</Show>
      <div class="k2b-inline-guidance__content">{local.children}</div>
    </div>
  );
}

export default InlineGuidance;
