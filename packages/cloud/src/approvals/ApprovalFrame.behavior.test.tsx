import { expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

const domTest = isServer ? test.skip : test;
const waitFor = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error("Approval detail interaction did not settle");
};

domTest("withdraw remains available in complete details, keeps a failed answer visible, and retries once", async () => {
  const dom = createDomTestHarness();
  const { ApprovalFrame } = await import("./ApprovalFrame");
  let attempts = 0;
  const dispose = render(
    () => (
      <ApprovalFrame
        locale="de"
        state="open"
        source={{ name: "Code", icon: "ti ti-code" }}
        sentence="Version 5 wartet auf einen Admin."
        reason={{ text: "Version 4 bleibt eingeschaltet" }}
        more={[
          {
            label: "Zurückziehen",
            onSelect: async () => {
              if (++attempts === 1) throw new Error("offline");
            },
          },
        ]}
        confirm={{
          label: "Einschalten",
          disabled: true,
          onSelect: () => {
            throw new Error("Unavailable approval must not run");
          },
        }}
      />
    ),
    dom.root,
  );
  try {
    const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button")];
    const button = (label: string) => buttons().find((b) => b.textContent?.trim() === label)!;
    expect(dom.root.querySelector("[data-approval-primary]")?.hasAttribute("disabled")).toBe(true);
    expect(button("Zurückziehen")).toBeUndefined();
    button("Alles ansehen").click();
    await waitFor(() => Boolean(document.querySelector(".cloud-approval-details")));
    button("Zurückziehen").click();
    await waitFor(() => attempts === 1 && Boolean(document.querySelector(".cloud-approval-details [role=alert]")?.textContent));
    expect(document.querySelector(".cloud-approval-details [role=alert]")?.textContent).toBe(
      "Deine Antwort konnte nicht gespeichert werden. Versuch es noch einmal.",
    );
    button("Zurückziehen").click();
    await waitFor(() => attempts === 2);
    expect(document.querySelector(".cloud-approval-details")).not.toBeNull();
  } finally {
    dispose();
    dom.cleanup();
  }
});

domTest("a deliberate focus move to the secondary control wins over an answer completing", async () => {
  const dom = createDomTestHarness();
  const { ApprovalFrame } = await import("./ApprovalFrame");
  let finish: (() => void) | undefined;
  const dispose = render(
    () => (
      <ApprovalFrame
        locale="de"
        state="open"
        source={{ name: "Mail", icon: "ti ti-mail" }}
        sentence="Nachricht senden?"
        reason={{ text: "Mail fragt nach" }}
        details={{ label: "Details von Mail", content: "Der Vorschlag" }}
        confirm={{
          label: "Senden",
          onSelect: () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
        }}
      />
    ),
    dom.root,
  );
  try {
    const primary = dom.root.querySelector<HTMLButtonElement>("[data-approval-primary]")!;
    const secondary = [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Alles ansehen")!;
    primary.focus();
    primary.click();
    await waitFor(() => primary.disabled && Boolean(finish));
    secondary.focus();
    finish!();
    await waitFor(() => !primary.disabled);
    await Bun.sleep(0);
    expect(document.activeElement).toBe(secondary);
  } finally {
    dispose();
    dom.cleanup();
  }
});

domTest("a failed detail module stays visible on the card and See everything retries it", async () => {
  const dom = createDomTestHarness();
  const { ApprovalFrame } = await import("./ApprovalFrame");
  let loads = 0;
  const dispose = render(
    () => (
      <ApprovalFrame
        locale="de"
        state="open"
        source={{ name: "Mail", icon: "ti ti-mail" }}
        sentence="Nachricht senden?"
        reason={{ text: "Mail fragt nach" }}
        details={{
          label: "Details von Mail",
          load: async () => {
            if (++loads === 1) throw new Error("chunk unavailable");
          },
          content: () => "Der vollständige Vorschlag",
        }}
      />
    ),
    dom.root,
  );
  try {
    const more = [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Alles ansehen")!;
    more.click();
    await waitFor(
      () =>
        loads === 1 && [...dom.root.querySelectorAll("[role=alert]")].some((n) => n.textContent?.includes("konnte nicht geladen werden")),
    );
    expect(document.querySelector(".cloud-approval-details")).toBeNull();
    expect(dom.root.textContent).toContain("Der vollständige Vorschlag konnte nicht geladen werden");
    more.click();
    await waitFor(() => Boolean(document.querySelector(".cloud-approval-details")));
    expect(loads).toBe(2);
    expect(document.querySelector(".cloud-approval-details")?.textContent).toContain("Der vollständige Vorschlag");
  } finally {
    dispose();
    dom.cleanup();
  }
});
