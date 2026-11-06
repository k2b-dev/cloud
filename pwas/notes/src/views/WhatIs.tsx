import { Button } from "@k2b/ui";
import { BRAND } from "../brand";
import { preferences } from "../prefs";
import { t } from "../state";
import { CLOUD_URL, Icon } from "../ui/common";
import { openSheet } from "../ui/sheet";

const ABOUT = {
  de: {
    lead: `${BRAND} ist ein Notizblock im Browser, ganz ohne Konto.`,
    localTitle: "Bleibt auf diesem Gerät",
    local: "Deine Notizen liegen nur hier im Browser.",
    shareTitle: "Teilen, wenn du willst",
    share: "Dann kommt die Notiz auf unseren Server, und alle mit dem Bearbeiten-Link schreiben live mit.",
    cloudBefore: "Gebaut mit ",
    cloud: "Die offene Plattform für deine eigenen Server.",
  },
  en: {
    lead: `${BRAND} is a notepad in your browser, with no account.`,
    localTitle: "Stays on this device",
    local: "Your notes live only here in the browser.",
    shareTitle: "Share when you want",
    share: "Then the note goes to our server, and everyone with the edit link writes along live.",
    cloudBefore: "Built with ",
    cloud: "The open platform for your own servers.",
  },
};

export function openWhatIs() {
  void openSheet((close) => {
    const about = () => ABOUT[preferences.locale()];
    return (
      <div class="n-dialog">
        <h2>{t().whatIs}</h2>
        <p class="n-about-lead">{about().lead}</p>
        <ul class="n-about">
          <li>
            <Icon name="ti-device-laptop" />
            <strong>{about().localTitle}</strong>
            <p>{about().local}</p>
          </li>
          <li>
            <Icon name="ti-users" />
            <strong>{about().shareTitle}</strong>
            <p>{about().share}</p>
          </li>
          <li>
            <img src="/cloud-logo.svg" alt="" />
            <strong>
              {about().cloudBefore}
              <a href={CLOUD_URL} target="_blank" rel="noopener">
                {t().cloud}
              </a>
            </strong>
            <p>{about().cloud}</p>
          </li>
        </ul>
        <div class="n-dialog-acts">
          <Button variant="primary" onClick={() => close()}>
            {t().close}
          </Button>
        </div>
      </div>
    );
  });
}
