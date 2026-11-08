import { type JSX, Show, splitProps } from "solid-js";
import type { NoticeTone } from "./NoticeCard";

export type NoticeRowProps = Omit<JSX.HTMLAttributes<HTMLElement>, "children" | "class"> & {
  tone?: NoticeTone;
  /**
   * A Tabler icon class on a soft square tile at the start of the row, for the subject the notice is about, such as
   * images. The tile is decorative; the text names the state.
   */
  tile?: string;
  /** The tile's colour as a CSS colour, such as a subject token; defaults to the tone's ink. */
  tileColor?: string;
  /** One short line; truncate it rather than letting the row grow. */
  children: JSX.Element;
  /** The one next step at the end of the row, such as a `Button` or a `SplitButton`. It never wraps below the text. */
  action?: JSX.Element;
  class?: string;
};

/**
 * A notice as one row of at least 48px: the tile, one line of text, then the action, all centred. It has the tint and
 * tones of `NoticeCard`, so a notice that changes state in place, such as blocked, loading, and failed, keeps its row and
 * the content below never moves.
 */
export function NoticeRow(props: NoticeRowProps): JSX.Element {
  const [local, articleProps] = splitProps(props, ["tone", "tile", "tileColor", "children", "action", "class"]);
  return (
    <article {...articleProps} class={`k2b-notice-card ${local.class ?? ""}`} data-tone={local.tone ?? "neutral"} data-row="">
      <Show when={local.tile}>
        {(tile) => (
          <span class="k2b-notice-card__tile k2b-icon-tile" style={{ color: local.tileColor }} aria-hidden="true">
            <i class={tile()} />
          </span>
        )}
      </Show>
      <div class="k2b-notice-card__content">{local.children}</div>
      <Show when={local.action}>{(action) => <div class="k2b-notice-card__action">{action()}</div>}</Show>
    </article>
  );
}
