import { coreClient } from "@k2b/cloud/clients/core";
import { formatBytes } from "@k2b/cloud/shared";
import { settingsSaveControls } from "@k2b/cloud/ssr/settings-draft";
import { useLocale } from "@k2b/ui";
import { Button, type NavProps, Notice, Popover, useToast } from "@k2b/ui/v2";
import { createSignal, type JSX, Show } from "solid-js";
import AreaFrame from "../_area/AreaFrame";
import CacheSection from "../_area/CacheSection";
import LegacySection, { type LegacyRow } from "../_area/LegacySection";
import RegistryForm, { type RegistryFormSection } from "../_area/RegistryForm";
import { adminToasts } from "../_area/toasts";
import { settingsMessages } from "../settings/_components/messages";
import type { SettingFieldDef } from "../settings/_components/setting-field";
import { baseAreaMessages } from "./messages";

export type BaseSectionId = "general" | "legal" | "pdf" | "places" | "cli";

type Frame = {
  nav: NavProps;
  section: BaseSectionId;
  /** The documentation article of the section, when the Cloud names a documentation website. */
  documentationHref?: string;
};

/**
 * Renders a test PDF with the saved settings; while the form has unsaved changes, it waits for Save. A rendered PDF is
 * a toast; a failure names Gotenberg's reason through `onFailure`, which the frame shows above the form.
 */
const TestPdf = (props: { onFailure: (reason: string | null) => void }) => {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  const n = () => adminToasts.resolve([locale()]).t;
  const toast = useToast();
  const [busy, setBusy] = createSignal(false);
  const pending = () => (settingsSaveControls()?.state ?? "saved") !== "saved";
  const run = async () => {
    setBusy(true);
    props.onFailure(null);
    try {
      const response = await coreClient.admin.core.settings["test-pdf"].$post();
      const body = (await response.json().catch(() => null)) as { message?: string; bytes?: number } | null;
      if (!response.ok) throw new Error(body?.message ?? t().pdfTestFailed({ status: response.status }));
      toast(n().pdfRendered({ size: formatBytes(body?.bytes ?? 0, { locale: locale() }) }), { status: "ok" });
    } catch (error) {
      props.onFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover tip={pending() ? t().testPdfPending : t().testPdfSaved}>
      <Button icon="file-type-pdf" busy={busy()} disabled={pending()} onClick={() => void run()}>
        {t().testRenderer}
      </Button>
    </Popover>
  );
};

/** The frame of every section of the Base settings area: the admin bar with the sections, the path, the guide link. */
export function BaseFrame(props: Frame & { children: JSX.Element }) {
  const locale = useLocale();
  const t = () => baseAreaMessages.resolve([locale()]).t;
  const n = () => adminToasts.resolve([locale()]).t;
  const [failure, setFailure] = createSignal<string | null>(null);
  return (
    <AreaFrame
      nav={props.nav}
      area={{ label: t().area, href: "/admin/base" }}
      title={t()[props.section]}
      description={t()[`${props.section}Description`]}
      documentationHref={props.documentationHref}
      actions={props.section === "pdf" ? <TestPdf onFailure={setFailure} /> : undefined}
    >
      <Show when={failure()}>
        {(reason) => (
          <Notice tone="bad" title={n().testFailed}>
            {reason()}
          </Notice>
        )}
      </Show>
      {props.children}
    </AreaFrame>
  );
}

export type BaseScreenProps = Frame & {
  groups: string[];
  sections: RegistryFormSection[];
  entries: SettingFieldDef[];
  /** General only: stored settings no app declares any more. */
  legacy?: LegacyRow[];
};

/** A registry section of the Base settings area on v2; General adds the cache and the settings no app declares. */
export default function BaseScreen(props: BaseScreenProps) {
  return (
    <BaseFrame nav={props.nav} section={props.section} documentationHref={props.documentationHref}>
      <RegistryForm groups={props.groups} sections={props.sections} entries={props.entries} />
      <Show when={props.legacy}>
        {(legacy) => (
          <>
            <CacheSection area="settings" />
            <LegacySection items={legacy()} />
          </>
        )}
      </Show>
    </BaseFrame>
  );
}
