import { t } from "../state";
import { Footer } from "../ui/common";
import { TopBarOverview } from "./Overview";

const TITLES = {
  datenschutz: () => t().privacy,
  nutzungsbedingungen: () => t().terms,
  impressum: () => t().imprint,
};

/** Placeholders until the legal review delivers the final texts (Schritt 5). */
export function Legal(props: { page: keyof typeof TITLES }) {
  return (
    <div class="n-page">
      <TopBarOverview menuOnly />
      <main class="n-legal">
        <h1>{TITLES[props.page]()}</h1>
        <p class="n-lead">{t().legalDraft}</p>
      </main>
      <Footer narrow />
    </div>
  );
}
