import { expect, test } from "bun:test";
import { PLACE_FORECASTS_AT_ONCE, placeForecasts } from "./place-forecasts";

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

test("the most places a person saves ask their forecasts a few at a time, each in its place (#4368)", async () => {
  const places = Array.from({ length: 100 }, (_, index) => `ort-${index}`);
  let open = 0;
  let most = 0;
  const forecast = async (place: string) => {
    open += 1;
    most = Math.max(most, open);
    // a later place answers sooner, so the order comes from the places, not from the answers
    await new Promise((resolve) => setTimeout(resolve, 100 - places.indexOf(place)));
    open -= 1;
    return `${place} sunny`;
  };
  expect(await placeForecasts(places, true, forecast)).toEqual(places.map((place) => `${place} sunny`));
  expect(most).toBe(PLACE_FORECASTS_AT_ONCE);
});
