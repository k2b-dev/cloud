import { type JSX, Show } from "solid-js";
import { renderSafeMarkdown } from "../content/MarkdownView";
import { useLocale } from "../intl/locale";

/** The links reading text may carry; any other target shows as text. */
const proseLinks = ["https:", "http:", "mailto:"] as const;

export type ProseProps =
  | {
      /**
       * Text in Markdown, such as a message. Raw HTML in it shows as text; links lead only to web pages and mail
       * addresses; images show their words, they load nothing.
       */
      markdown: string;
      children?: never;
    }
  | {
      markdown?: never;
      /** Reading text as elements, when it is not Markdown. */
      children: JSX.Element;
    };

/** Reading text: 14/22, a measure of 720 px, headings at 16 and 18. It carries the text edge itself. */
export const Prose = (props: ProseProps) => {
  const locale = useLocale();
  return (
    <Show
      when={props.markdown !== undefined}
      fallback={
        <div class="k2-prose" data-k2-part="Prose" data-k2-prose="">
          {props.children}
        </div>
      }
    >
      <div
        class="k2-prose"
        data-k2-part="Prose"
        data-k2-prose=""
        innerHTML={renderSafeMarkdown(props.markdown ?? "", { locale: locale(), allowImages: false, linkProtocols: proseLinks })}
      />
    </Show>
  );
};
