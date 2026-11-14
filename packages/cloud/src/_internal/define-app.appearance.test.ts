import { expect, test } from "bun:test";
import { defineApp } from "./define-app";

const options = {
  id: "appearance-probe",
  name: "Appearance probe",
  icon: "ti ti-palette",
  description: "Invented AI application",
  baseUrl: "http://appearance-probe:3000",
  routes: ["/app/appearance-probe"],
};

test("any application can declare the AI primary; omitted primary stays absent in metadata", () => {
  for (const primary of [undefined, "ai"] as const) {
    const appearance = { accent: "#0f766e" as const, primary };
    expect(defineApp({ ...options, appearance }).meta.appearance).toEqual(appearance);
  }
  expect(defineApp(options).meta.appearance).toBeUndefined();
});

test("invalid primary values fail at declaration with the app and supported value", () => {
  for (const primary of ["blue", "plum", "AI", "", null, false, 1, {}]) {
    expect(() =>
      defineApp({
        ...options,
        // @ts-expect-error Untyped declaration input must fail at runtime too.
        appearance: { accent: "#0f766e", primary },
      }),
    ).toThrow('App "appearance-probe" declares invalid appearance: appearance.primary must be "ai" or omitted (blue)');
  }
});
