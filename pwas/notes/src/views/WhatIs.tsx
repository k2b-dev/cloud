import { Button } from "@k2b/ui";
import { BRAND } from "../brand";
import { preferences } from "../prefs";
import { t } from "../state";
import { CLOUD_URL, WithCloud } from "../ui/common";
import { openSheet } from "../ui/sheet";

const BODY = {
  de: [
    `${BRAND} ist ein Notizblock im Browser. Deine Notizen liegen nur auf diesem Gerät, es gibt kein Konto.`,
    "Wenn du teilst, kommt die Notiz auf unseren Server. Dann schreiben alle mit dem Bearbeiten-Link live mit.",
  ],
  en: [
    `${BRAND} is a notepad in your browser. Your notes stay on this device; there is no account.`,
    "When you share, the note goes to our server. Then everyone with the edit link writes along live.",
  ],
};

export function openWhatIs() {
  void openSheet((close) => (
    <div class="n-dialog">
      <h2>{t().whatIs}</h2>
      {BODY[preferences.locale()].map((line) => (
        <p class="n-lead">{line}</p>
      ))}
      <a class="n-more" href={CLOUD_URL} target="_blank" rel="noopener">
        <img src="/cloud-logo.svg" alt="" />
        <span>
          {BRAND} <WithCloud text={t().builtWith} />
        </span>
      </a>
      <div class="n-dialog-acts">
        <Button variant="primary" onClick={() => close()}>
          {t().close}
        </Button>
      </div>
    </div>
  ));
}
