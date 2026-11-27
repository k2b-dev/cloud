import { expect, test } from "bun:test";
import { placeForecasts } from "./place-forecasts";

test("a place page asks one forecast per saved place, and none when the address names no saved place", async () => {
  const asked: string[] = [];
  const forecast = async (place: string) => {
    asked.push(place);
    return `${place} sunny`;
  };
  expect(await placeForecasts(["ulm", "berlin"], true, forecast)).toEqual(["ulm sunny", "berlin sunny"]);
  expect(asked).toEqual(["ulm", "berlin"]);

  asked.length = 0;
  expect(await placeForecasts(["ulm", "berlin"], false, forecast)).toEqual([null, null]);
  expect(asked).toEqual([]);
});
