import { appAccentStyle } from "@k2b/cloud/ssr/app-appearance";

/** An app's icon in the soft chip of its registered accent; an app without one gets neutral ink. */
export const AppIcon = (props: { icon: string; accent: string | undefined }) => {
  const style = appAccentStyle(props.accent);
  return (
    <span class={`k2b-icon-tile h-6 w-6 ${style ? "app-accent-scope app-accent-text" : "text-secondary"}`} style={style} aria-hidden="true">
      <i class={`${props.icon} text-[10px]`} />
    </span>
  );
};
