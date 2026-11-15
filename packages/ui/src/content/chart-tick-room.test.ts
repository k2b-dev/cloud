import { expect, test } from "bun:test";
import { tickRooms } from "./chart-tick-room";

test("every second date gives way first, then every fourth; the first always stays", () => {
  // Eight dates 60 px apart on a 480 px drawing, each label about 7 characters.
  const rooms = tickRooms(
    Array.from({ length: 8 }, (_, index) => 40 + index * 60),
    Array.from({ length: 8 }, () => "21. Juni"),
    480,
  );
  expect(rooms[0]).toBe(0);
  // Odd places need the most room, places 2 and 6 half of it, place 4 a quarter.
  expect(rooms[1]).toBe(rooms[3]);
  expect(rooms[2]).toBe(rooms[6]);
  expect(rooms[2]!).toBeLessThan(rooms[1]!);
  expect(rooms[4]!).toBeLessThan(rooms[2]!);
  // At the drawing width these labels fit with room to spare, so none gives way there.
  expect(Math.max(...rooms)).toBeLessThanOrEqual(480);
});

test("one label, no width or no spacing needs no room", () => {
  expect(tickRooms([10], ["Mai"], 480)).toEqual([0]);
  expect(tickRooms([10, 20], ["a", "b"], 0)).toEqual([0, 0]);
  expect(tickRooms([10, 10], ["a", "b"], 480)).toEqual([0, 0]);
});
