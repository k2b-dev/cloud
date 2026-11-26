import { render } from "solid-js/web";
import { FaqAdminFixture, FaqScreenFixture } from "./faq-screens.fixture";

/** The FAQ screens for a browser test: the path picks the screen, the document says the locale and the data set. */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const { lang, dataset } = document.documentElement;
const worst = dataset.state === "worst";
const empty = dataset.state === "empty";
render(
  () =>
    location.pathname === "/faq" ? (
      <FaqScreenFixture locale={lang} worst={worst} empty={empty} />
    ) : (
      <FaqAdminFixture search={location.search} locale={lang} worst={worst} empty={empty} />
    ),
  host,
);
document.body.dataset.ready = "true";
