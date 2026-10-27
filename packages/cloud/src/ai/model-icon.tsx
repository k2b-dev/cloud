import type { JSX } from "solid-js";
import { type AiModelIcon as AiModelIconSetting, type AiPeopleModelIcon, aiProviderMark } from "../shared/ai-models";

/** The icon a person sees for a model: its emoji or image, else its provider's neutral mark. */
export const aiModelDisplayIcon = (icon: AiModelIconSetting, provider: { id: string; label: string }): AiPeopleModelIcon =>
  icon.kind === "image"
    ? { kind: "image", src: icon.dataUrl }
    : icon.kind === "emoji"
      ? icon
      : { kind: "mark", ...aiProviderMark(provider) };

const sizes = { xs: "size-5 rounded-[5px] text-[9px]", sm: "size-7 rounded-md text-[10px]", md: "size-10 rounded-lg text-xs" } as const;

/**
 * A model's icon, the one mark that tells models apart in a chooser. It is decoration: the model's name always sits
 * next to it, so it stays hidden from assistive technology.
 */
export function AiModelIcon(props: { icon: AiPeopleModelIcon; size?: keyof typeof sizes; class?: string }): JSX.Element {
  const box = () =>
    `inline-grid shrink-0 place-items-center overflow-hidden leading-none ${sizes[props.size ?? "xs"]} ${props.class ?? ""}`;
  const icon = () => props.icon;
  return (
    <span class={box()} aria-hidden="true" data-ai-model-icon={icon().kind}>
      {(() => {
        const current = icon();
        if (current.kind === "image") return <img src={current.src} alt="" class="size-full object-cover" />;
        if (current.kind === "emoji") return <span class="text-[1.15em]">{current.emoji}</span>;
        return (
          <span class="grid size-full place-items-center font-semibold tracking-wide text-white" style={{ background: current.color }}>
            {current.text}
          </span>
        );
      })()}
    </span>
  );
}
