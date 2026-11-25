import { coreClient } from "@k2b/cloud/clients/core";
import { formatDateTime } from "@k2b/cloud/shared";
import { useLocale } from "@k2b/ui";
import { Chip, Dialog, Section, Table, useToast } from "@k2b/ui/v2";
import { createSignal } from "solid-js";
import { settingsMessages } from "../settings/_components/messages";

/** A stored setting no app declares any more, as the server lists it. */
export type LegacySetting = { key: string; updatedAt: string | null; decryptable: boolean };
/** The same with its time worded by the server, so the first picture in the browser is the server's. */
export type LegacyRow = LegacySetting & { updated: string };

/**
 * The stored settings no app declares any more, read by the server with the page, and the deed that removes them after
 * one question. The list is read again after the deed.
 */
export default function LegacySection(props: { items: LegacyRow[] }) {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  const toast = useToast();
  const [items, setItems] = createSignal(props.items);
  const [busy, setBusy] = createSignal(false);
  const message = async (response: { json(): Promise<unknown> }, fallback: string) =>
    ((await response.json().catch(() => null)) as { message?: string } | null)?.message ?? fallback;

  const cleanUp = async () => {
    const count = items().length;
    if (!(await Dialog.confirm({ title: t().cleanUpConfirm({ count }), confirm: t().cleanUp }))) return;
    setBusy(true);
    try {
      const response = await coreClient.admin.core.settings.legacy.$delete();
      if (!response.ok) throw new Error(await message(response, t().cleanUpFailed));
      const { deleted } = (await response.json()) as { deleted: string[] };
      toast(t().legacyDeleted({ count: deleted.length }), { status: "ok" });
      const next = await coreClient.admin.core.settings.legacy.$get();
      const listed = next.ok ? ((await next.json()) as LegacySetting[]) : items().filter((item) => !deleted.includes(item.key));
      setItems(listed.map((item) => ({ ...item, updated: formatDateTime(item.updatedAt, { locale: locale() }) })));
    } catch (error) {
      toast(error instanceof Error ? error.message : t().cleanUpFailed, { status: "bad" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      icon="database-off"
      title={t().legacySettings}
      count={items().length}
      summary={t().legacySettingsDescription}
      actions={[{ label: t().cleanUp, icon: "trash", onClick: () => void cleanUp(), disabled: busy() || items().length === 0 }]}
    >
      <Table
        label={t().legacySettings}
        rows={items()}
        rowKey={(row) => row.key}
        empty={{ icon: "circle-check", text: t().noLegacySettings }}
        phone={(row) => ({ lines: [row.key, row.updated] })}
        columns={[
          { title: t().key, width: { min: 200, default: 320 }, cell: (row) => row.key },
          {
            title: t().status,
            width: { min: 120, default: 140 },
            cell: (row) => <Chip status={row.decryptable ? "warn" : "bad"}>{row.decryptable ? t().unregistered : t().unreadable}</Chip>,
          },
          { title: t().updated, align: "end", cell: (row) => row.updated, drop: true },
        ]}
      />
    </Section>
  );
}
