import { expect, test } from "bun:test";
import { readServerEnv } from "./env";

test("the public server requires its own explicit origin", () => {
  const previous = process.env.SPEEDTEST_PUBLIC_URL;
  try {
    for (const value of [undefined, "", " "]) {
      if (value === undefined) delete process.env.SPEEDTEST_PUBLIC_URL;
      else process.env.SPEEDTEST_PUBLIC_URL = value;
      expect(() => readServerEnv()).toThrow("SPEEDTEST_PUBLIC_URL is required");
    }
    process.env.SPEEDTEST_PUBLIC_URL = "https://speedtest.example.com/";
    expect(readServerEnv().publicUrl).toBe("https://speedtest.example.com");
    process.env.SPEEDTEST_PUBLIC_URL = "https://speedtest.example.com/other";
    expect(() => readServerEnv()).toThrow("must be an origin");
  } finally {
    if (previous === undefined) delete process.env.SPEEDTEST_PUBLIC_URL;
    else process.env.SPEEDTEST_PUBLIC_URL = previous;
  }
});
