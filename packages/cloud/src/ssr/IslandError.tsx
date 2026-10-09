import type { IslandErrorProps } from "@k2b/ssr";
import { i18n } from "@k2b/stdlib";
import { Button, Placeholder, useLocale } from "@k2b/ui";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { title: "This section could not be displayed.", retry: "Try again" },
    de: { title: "Dieser Bereich konnte nicht angezeigt werden.", retry: "Erneut versuchen" },
  },
});

/**
 * Takes the place of an island or client component whose rendering failed.
 * `defineApp` hands it to @k2b/ssr as `errorFallback`, so every island of every
 * app gets it; the locale comes from `<html lang>`. "Try again" remounts the
 * island with its original props.
 */
export default function IslandError(props: IslandErrorProps) {
  const locale = useLocale();
  const t = () => messages.resolve([locale()]).t;
  return (
    <Placeholder
      state="error"
      title={t().title}
      action={
        <Button variant="secondary" onClick={() => props.reset()}>
          {t().retry}
        </Button>
      }
    />
  );
}
