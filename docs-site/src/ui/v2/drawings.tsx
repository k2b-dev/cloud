import { For } from "solid-js";

// Drawings that stand inside a v2 `Canvas` on the Fibel screens, like `<Canvas><MapView /></Canvas>` in an app: the
// Canvas is the one place where own CSS is allowed (`.ui-v2-composer`, `.ui-v2-map` in cloud-ui.css). Neither is a v2
// primitive: the composer comes from @k2b/editor later, the map from a map view.

/** The mail composer of the mockup (variant A). */
export const ComposerDrawing = () => (
  <div class="ui-v2-composer">
    <div class="ui-v2-composer__top">
      <i class="ti ti-arrow-back-up" />
      <span class="ui-v2-composer__to">An</span>Holzwerk Brandt
      <i class="ti ti-x" />
      <span class="ui-v2-composer__fill" />
      <span class="ui-v2-composer__text">
        von Kontakt
        <i class="ti ti-chevron-down" />
      </span>
      <span class="ui-v2-composer__text">Cc</span>
      <span class="ui-v2-composer__text">Bcc</span>
    </div>
    <div class="ui-v2-composer__write">
      <span>Antwort an Holzwerk Brandt schreiben …</span>
      <span class="ui-v2-composer__sig">
        Mira Solberg
        <br />
        Tischlerei Solberg &amp; Kramer
      </span>
    </div>
    <div class="ui-v2-composer__bottom">
      <For each={["typography", "paperclip", "signature", "sparkles"]}>
        {(name) => (
          <span class="ui-v2-composer__tool">
            <i class={`ti ti-${name}`} />
          </span>
        )}
      </For>
      <span class="ui-v2-composer__fill" />
      <span class="ui-v2-composer__tool">
        <i class="ti ti-trash" />
      </span>
      <span class="ui-v2-composer__send">
        <i class="ti ti-send" />
        Senden
      </span>
    </div>
  </div>
);

/** The small map of a customer's address in the mockup. */
export const MapDrawing = (props: { address: string }) => (
  <div class="ui-v2-map">
    <span class="ui-v2-map__open">
      <i class="ti ti-external-link" />
      In Karten öffnen
    </span>
    <span class="ui-v2-map__pin">K</span>
    <span class="ui-v2-map__address">{props.address}</span>
  </div>
);
