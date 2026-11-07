import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

const dom = isServer ? undefined : createDomTestHarness();
const reload = isServer ? undefined : await import("@k2b/cloud/browser/reload");
const modules = isServer ? undefined : await import("./deferred-chat-content");
const ui = isServer ? undefined : await import("@k2b/ui");
let dispose = () => {};
afterEach(() => {
  dispose();
  mock.restore();
});
process.once("exit", () => dom?.cleanup());

if (isServer) test.skip("requires browser conditions", () => {});
else {
  const mount = (props: {
    load: () => Promise<(props: { label: string }) => import("solid-js").JSX.Element>;
    contentProps: { label: string };
    dialog?: boolean;
  }) => {
    const host = document.createElement("div");
    document.body.append(host);
    const stop = render(
      () =>
        createComponent(ui!.LocaleProvider, {
          locale: "en",
          get children() {
            return createComponent(modules!.DeferredChatContent, props);
          },
        }),
      host,
    );
    dispose = () => {
      stop();
      host.remove();
    };
    return host;
  };
  const settle = async () => {
    await Bun.sleep(0);
  };
  test("the destination shows loading immediately, then keeps live props in its loaded content", async () => {
    let finish!: (component: (props: { label: string }) => ReturnType<typeof createComponent>) => void;
    const loaded = new Promise<(props: { label: string }) => ReturnType<typeof createComponent>>((resolve) => {
      finish = resolve;
    });
    const [label, setLabel] = createSignal("First");
    const host = mount({
      load: () => loaded,
      contentProps: {
        get label() {
          return label();
        },
      },
      dialog: true,
    });
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    finish((props) => <span>{props.label}</span>);
    await settle();
    expect(host.textContent).toBe("First");
    setLabel("Second");
    expect(host.textContent).toBe("Second");
  });
  test("a failed chunk stays visible and Retry loads the same destination", async () => {
    const load = spyOn(reload!, "importOnDemand")
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async (loader) => loader());
    const host = mount({ load: async () => (props: { label: string }) => props.label, contentProps: { label: "Recovered" } });
    await settle();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    host.querySelector<HTMLButtonElement>("button")!.click();
    await settle();
    expect(host.textContent).toBe("Recovered");
    expect(load).toHaveBeenCalledTimes(2);
  });
  test("loaded dialog content receives initial focus", async () => {
    let finish!: (component: () => ReturnType<typeof createComponent>) => void;
    const loaded = new Promise<() => ReturnType<typeof createComponent>>((resolve) => {
      finish = resolve;
    });
    const host = mount({ load: () => loaded, contentProps: { label: "Name" }, dialog: true });
    const dialog = document.createElement("dialog");
    const close = document.createElement("button");
    document.body.append(dialog);
    dialog.append(close, host);
    close.focus();
    finish(() => <input aria-label="Name" />);
    await settle();
    expect(document.activeElement).toBe(host.querySelector("input"));
    dispose();
    dialog.remove();
  });
  test("closing during a load never creates the late content", async () => {
    let finish!: (component: (props: { label: string }) => string) => void;
    const loaded = new Promise<(props: { label: string }) => string>((resolve) => {
      finish = resolve;
    });
    const content = mock((props: { label: string }) => props.label);
    mount({ load: () => loaded, contentProps: { label: "Late" } });
    dispose();
    finish(content);
    await settle();
    expect(content).not.toHaveBeenCalled();
  });
}
