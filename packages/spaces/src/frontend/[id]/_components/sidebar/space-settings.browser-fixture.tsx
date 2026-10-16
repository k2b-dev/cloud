import { type DateContext, dates } from "@k2b/stdlib";
import { LocaleProvider } from "@k2b/ui";
import SpaceLiveEvents from "../workspace/SpaceLiveEvents.island";
import SpaceSettingsButton from "./SpaceSettingsButton.island";

type Props = { locale: string; snapshotTime: string };

/** The settings button and live subscription share the page's server locale and day. */
export default function SpaceSettingsFixture(props: Props) {
  const dateConfig: DateContext = { locale: props.locale, timeZone: "Europe/Berlin", firstDayOfWeek: 1 };
  return (
    <LocaleProvider locale={props.locale}>
      <SpaceSettingsButton spaceId="Space1" baseUrl="" variant="sidebar" dateConfig={dateConfig} />
      <SpaceLiveEvents
        spaceId="Space1"
        initialCursor="c0"
        snapshotDay={dates.formatDateKey(new Date(props.snapshotTime), dateConfig)}
        dateConfig={dateConfig}
      />
    </LocaleProvider>
  );
}
