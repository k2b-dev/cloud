import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { type HTMLInputElement, Window } from "happy-dom";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";
import type { ChatDecisionFieldProps, ChatDecisionProps } from "../index";

// A question that asks for one value. The value is fictional and must never leave the input.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-decision-field-tests-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { Chat, ChatDecisionFacts, ChatDecisionField } = await import("../index");
const window = new Window();
const render = (content: () => JSX.Element) => {
  const body = window.document.createElement("div");
  body.innerHTML = renderToString(content);
  return body;
};
const noop = () => undefined;
const value = "pk_live_FICTIONAL_7f3Q";
const lines: ChatDecisionFieldProps["lines"] = {
  safe: { text: "Not in the chat history; nobody sees the value.", icon: "ti ti-shield-lock" },
  held: { text: "Open in another window. Answer there.", icon: "ti ti-devices" },
  empty: { text: "Paste the key first.", icon: "ti ti-alert-circle", tone: "danger" },
  conflict: { text: "Changed meanwhile. Use your value anyway?", icon: "ti ti-alert-triangle", tone: "warning" },
};
const decision = (field: Partial<ChatDecisionFieldProps> = {}, extra: Partial<ChatDecisionProps> = {}) =>
  createComponent(Chat.Decision, {
    state: "open",
    kind: { label: "Secret", icon: "ti ti-key" },
    sentence: "Add Parcel_API?",
    details: {
      get content() {
        return createComponent(ChatDecisionFacts, {
          lines: [
            { text: "Only for you in this chat", icon: "ti ti-message-circle" },
            { text: "Goes only to api.parcel.example", icon: "ti ti-world" },
          ],
        });
      },
    },
    get entry() {
      return createComponent(ChatDecisionField, {
        label: "Value for Parcel_API",
        value: "",
        onValueChange: noop,
        placeholder: "Paste the key",
        revealLabel: "Show value",
        lines,
        current: "safe",
        confirm: {
          label: "Save securely",
          icon: "ti ti-lock",
          alternates: [
            { label: "Saving …", icon: "ti ti-loader-2" },
            { label: "Try again", icon: "ti ti-refresh" },
            { label: "Replace anyway" },
          ],
          onSelect: noop,
        },
        decline: { label: "Decline", onSelect: noop },
        ...field,
      });
    },
    ...extra,
  });

describe("Chat.Decision with a field, SSR", () => {
  test("head without a source, facts without a label, no reason, then the field row in place of the answer row", () => {
    const body = render(() => decision());
    const section = body.querySelector("section")!;
    expect(section.getAttribute("data-mode")).toBe("approve");
    expect(section.hasAttribute("aria-describedby")).toBe(false);
    expect(Array.from(section.children).map((e) => e.className)).toEqual([
      "k2b-chat-decision__head",
      "k2b-chat-decision__sentence",
      "k2b-chat-decision__details",
      "k2b-chat-decision__entry",
    ]);
    expect(body.querySelector(".k2b-chat-decision__head")!.textContent).toBe("Secret");
    expect(body.querySelector(".k2b-chat-decision__details-label")).toBeNull();
    expect(Array.from(body.querySelectorAll(".k2b-chat-decision__fact-line")).map((line) => line.textContent)).toEqual([
      "Only for you in this chat",
      "Goes only to api.parcel.example",
    ]);
    expect(body.querySelector(".k2b-chat-decision__answers")).toBeNull();
    expect(Array.from(body.querySelector(".k2b-chat-decision__entry")!.children).map((e) => e.className.trim())).toEqual([
      "k2b-chat-decision__field",
      "k2b-button k2b-chat-decision__answer k2b-chat-decision__confirm",
      "k2b-chat-decision__line-cell",
      "k2b-button k2b-chat-decision__answer k2b-chat-decision__decline",
      "k2b-sr-only",
    ]);
  });

  test("the field is a password field named by its label, without autofill or spelling, described by the current line", () => {
    const body = render(() => decision());
    const input = body.querySelector<HTMLInputElement>(".k2b-chat-decision__field input")!;
    expect(input.type).toBe("password");
    expect(input.getAttribute("aria-label")).toBe("Value for Parcel_API");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(input.getAttribute("placeholder")).toBe("Paste the key");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    const current = body.querySelector('.k2b-chat-decision__line[data-current="true"]')!;
    expect(input.getAttribute("aria-describedby")).toBe(current.id);
    expect(current.textContent).toBe("Not in the chat history; nobody sees the value.");
    // The eye keeps one name; whether the value shows is its pressed state.
    const eye = body.querySelector(".k2b-input-shell__reveal")!;
    expect(eye.getAttribute("aria-label")).toBe("Show value");
    expect(eye.getAttribute("aria-pressed")).toBe("false");
  });

  test("every line and every label shares one cell: only the current one is seen and named", () => {
    const body = render(() => decision({ current: "conflict" }));
    const cell = Array.from(body.querySelectorAll(".k2b-chat-decision__line"));
    expect(
      cell.map((line) => [line.getAttribute("data-tone"), line.getAttribute("data-current"), line.getAttribute("aria-hidden")]),
    ).toEqual([
      ["neutral", null, "true"],
      ["neutral", null, "true"],
      ["danger", null, "true"],
      ["warning", "true", null],
    ]);
    const confirm = body.querySelector(".k2b-chat-decision__confirm")!;
    expect(confirm.getAttribute("data-variant")).toBe("ai");
    expect(
      Array.from(confirm.querySelectorAll(".k2b-chat-decision__face")).map((face) => [face.textContent, face.getAttribute("aria-hidden")]),
    ).toEqual([
      ["Save securely", null],
      ["Saving …", "true"],
      ["Try again", "true"],
      ["Replace anyway", "true"],
    ]);
    const decline = body.querySelector(".k2b-chat-decision__decline")!;
    expect(decline.getAttribute("data-variant")).toBe("text");
    expect(decline.textContent).toBe("Decline");
    expect(body.querySelectorAll('[aria-live="polite"]').length).toBe(1);
  });

  test("an invalid value marks the field and points to its line as the error", () => {
    const body = render(() => decision({ current: "empty", invalid: true }));
    const input = body.querySelector<HTMLInputElement>(".k2b-chat-decision__field input")!;
    const current = body.querySelector('.k2b-chat-decision__line[data-current="true"]')!;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(current.id);
    expect(body.querySelector(".k2b-input-shell")!.getAttribute("data-invalid")).toBe("true");
    // The line is the only error text: no second message under the field.
    expect(body.querySelector(".k2b-field__error")).toBeNull();
  });

  test("disabled locks the field, the eye and both answers", () => {
    const body = render(() => decision({ disabled: true, current: "held" }));
    expect(Array.from(body.querySelectorAll<HTMLInputElement>("input, button")).map((control) => control.disabled)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  test("waiting keeps the field and turns both answers off", () => {
    const body = render(() => decision({}, { waiting: { text: "Offline.", icon: "ti ti-wifi-off" } }));
    expect(body.querySelector<HTMLInputElement>(".k2b-chat-decision__field input")!.disabled).toBe(false);
    expect(Array.from(body.querySelectorAll<HTMLInputElement>(".k2b-chat-decision__answer")).map((b) => b.disabled)).toEqual([true, true]);
  });

  test("the value appears nowhere but in the input, and the island waits for the browser", () => {
    const body = render(() => decision({ value }, { anchorId: "q1" }));
    // The island follows the value in the browser only, so the server page matches the first frame there.
    expect(body.querySelector("section")!.getAttribute("data-mode")).toBe("approve");
    const input = body.querySelector<HTMLInputElement>(".k2b-chat-decision__field input")!;
    expect(input.value).toBe(value);
    input.remove();
    expect(body.innerHTML).not.toContain(value);
  });

  test("closed, the field is gone with its value", () => {
    const body = render(() => decision({ value }, { state: "decided", outcome: "Saved" }));
    expect(body.querySelector("input")).toBeNull();
    expect(body.innerHTML).not.toContain(value);
    expect(body.querySelector("section")!.getAttribute("aria-label")).toBe("Secret");
  });
});
