import { expect, test } from "bun:test";
import { findFilledIcons } from "./tabler-filled";

test("filled Tabler classes and names are found, outline names and attributes are not", () => {
  const source = [
    '<i class="ti ti-star-filled" aria-hidden="true" />',
    'icon: props.pinned ? "ti ti-flag" : "ti ti-circle-filled",',
    'E("heart-filled", "Heart Filled", ["heart"]),',
    '<Icon name="player-play-filled" />',
    '<i class="ti ti-star" /> <div data-filled="true" /> "data-filled"',
  ].join("\n");
  expect(findFilledIcons(source)).toEqual([
    { line: 1, name: "ti-star-filled" },
    { line: 2, name: "ti-circle-filled" },
    { line: 3, name: "heart-filled" },
    { line: 4, name: "player-play-filled" },
  ]);
});
