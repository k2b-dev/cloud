import { useLocale } from "@k2b/ui";
import { List, Row, Section } from "@k2b/ui/v2";
import { For } from "solid-js";
import { localizeSettingField } from "../settings/_components/setting-copy";
import type { SettingFieldDef } from "../settings/_components/setting-field";
import { areaFormMessages } from "./messages";

/** One stored change of a setting: who and when, the time worded by the server so both renders agree. */
export type RecentChange = { key: string; label: string; who: string; when: string };

/** The latest stored changes of the given settings that name a person, newest first. */
export const recentChanges = (
  entries: readonly SettingFieldDef[],
  locale: string,
  word: (iso: string) => string,
  limit = 5,
): RecentChange[] =>
  entries
    .filter((entry): entry is SettingFieldDef & { updatedAt: string; updatedBy: { id: string; name: string } } =>
      Boolean(entry.updatedAt && entry.updatedBy),
    )
    .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit)
    .map((entry) => ({
      key: entry.key,
      // the name the form shows for the setting, in the page's language
      label: localizeSettingField(entry, locale).label,
      who: entry.updatedBy.name,
      when: word(entry.updatedAt),
    }));

/**
 * The column of a settings section while some of its settings name who changed them; none otherwise (rule 5). Called
 * while a screen renders, so it reads the screen's language.
 */
export const recentSide = (items: readonly RecentChange[] | undefined) => {
  const locale = useLocale();
  const changes = items ?? [];
  return changes.length
    ? { label: areaFormMessages.resolve([locale()]).t.recentChanges, content: <RecentChanges items={changes} /> }
    : undefined;
};

/** The column beside a settings section: who changed which of its settings lately, as the settings recipe shows. */
export default function RecentChanges(props: { items: readonly RecentChange[] }) {
  const locale = useLocale();
  const t = () => areaFormMessages.resolve([locale()]).t;
  return (
    <Section title={t().recentChanges}>
      <List label={t().recentChanges}>
        <For each={props.items}>{(item) => <Row avatar={{ name: item.who }} lines={[item.label, item.who]} time={item.when} />}</For>
      </List>
    </Section>
  );
}
