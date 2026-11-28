import { expect, test } from "bun:test";
import { initialsOf } from "./types";

// break-ui 25.11.: "�P" for "👩🏽‍💻 Priya" (half an emoji) and "CA" for "Christopher Alexander Montgomery III".
test("initials take the first and the last word, whole characters, and leave out suffixes and signs", () => {
  expect(initialsOf({ name: "Ada Lovelace" })).toBe("AL");
  expect(initialsOf({ name: "Christopher Alexander Montgomery III" })).toBe("CM");
  expect(initialsOf({ name: "Martin Luther King Jr." })).toBe("MK");
  expect(initialsOf({ name: "👩🏽‍💻 Priya" })).toBe("P");
  expect(initialsOf({ name: "Đặng Thị Ngọc Hân" })).toBe("ĐH");
  expect(initialsOf({ name: "  jo  " })).toBe("J");
  expect(initialsOf({ name: "Nguyen Vi" })).toBe("NV");
  // a name of signs only keeps its first character whole
  expect(initialsOf({ name: "👩🏽‍💻" })).toBe("👩🏽‍💻");
  expect(initialsOf({ name: "" })).toBe("");
  expect(initialsOf({ name: "Ada Lovelace", initials: "XY" })).toBe("XY");
});
