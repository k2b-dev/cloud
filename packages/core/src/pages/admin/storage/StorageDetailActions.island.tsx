import { Button, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import { storageDetailControls } from "./detail-controls";
import { storageAreaMessages } from "./messages";

/**
 * Test, Remove and Save (or Restore) in the detail level's head. Each button the page announces keeps its place
 * disabled until the detail island registers, so the head does not shift when it hydrates.
 */
export default function StorageDetailActions(props: {
  test?: boolean;
  remove?: boolean;
  save?: "save" | "create";
  restore?: boolean;
  testLabel?: "test" | "testAgain";
}) {
  const locale = useLocale();
  const t = () => storageAreaMessages.resolve([locale()]).t;
  const controls = storageDetailControls;
  const busy = () => Boolean(controls()?.save?.saving || controls()?.test?.busy || controls()?.restore?.busy);
  return (
    <div class="flex items-center gap-2">
      <Show when={props.test}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={controls()?.test?.busy}
          loadingLabel={t().testing}
          disabled={!controls()?.test || controls()?.test?.disabled || busy()}
          data-storage-action="test"
          onClick={() => controls()?.test?.run()}
        >
          {props.testLabel === "testAgain" ? t().testAgain : t().test}
        </Button>
      </Show>
      <Show when={props.remove}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!controls()?.remove || controls()?.remove?.disabled || busy()}
          data-storage-action="remove"
          onClick={() => controls()?.remove?.run()}
        >
          {t().remove}
        </Button>
      </Show>
      <Show when={props.restore}>
        <Button
          type="button"
          size="sm"
          loading={controls()?.restore?.busy}
          loadingLabel={t().saving}
          disabled={!controls()?.restore || controls()?.restore?.disabled || busy()}
          data-storage-action="restore"
          onClick={() => controls()?.restore?.run()}
        >
          {t().restore}
        </Button>
      </Show>
      <Show when={props.save}>
        <Button
          type="button"
          size="sm"
          loading={controls()?.save?.saving}
          loadingLabel={t().saving}
          disabled={!controls()?.save?.dirty || controls()?.save?.disabled || busy()}
          data-storage-action="save"
          onClick={() => controls()?.save?.run()}
        >
          {props.save === "create" ? t().create : t().save}
        </Button>
      </Show>
    </div>
  );
}
