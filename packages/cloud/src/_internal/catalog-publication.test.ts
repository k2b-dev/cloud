import { expect, setSystemTime, test } from "bun:test";
import { createCatalogPublication } from "./catalog-publication";

for (const count of [5, 20]) {
  test(`${count} apps publish each catalog once across an idle hour, then once per changed hash`, async () => {
    setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const writes = { help: 0, skills: 0 };
    const apps = Array.from({ length: count }, () => ({ help: createCatalogPublication(), skills: createCatalogPublication() }));
    const round = async (hash: string) => {
      for (const app of apps) {
        await app.help(hash, async () => {
          writes.help++;
        });
        await app.skills(hash, async () => {
          writes.skills++;
          return true;
        });
      }
    };
    try {
      await round("initial");
      expect(writes).toEqual({ help: count, skills: count });
      for (let minute = 1; minute <= 60; minute++) {
        setSystemTime(new Date(Date.UTC(2030, 0, 1, 0, minute)));
        await round("initial");
      }
      expect(writes).toEqual({ help: count, skills: count });
      await apps[0]!.help("changed", async () => {
        writes.help++;
      });
      await apps[0]!.skills("changed", async () => {
        writes.skills++;
      });
      await apps[0]!.help("changed", async () => {
        writes.help++;
      });
      await apps[0]!.skills("changed", async () => {
        writes.skills++;
      });
      expect(writes).toEqual({ help: count + 1, skills: count + 1 });
    } finally {
      setSystemTime();
    }
  });
}

test("missing schemas and failed writes retry; concurrent preparations publish once", async () => {
  const publish = createCatalogPublication();
  let writes = 0;
  await publish("hash", async () => false);
  await expect(
    publish("hash", async () => {
      throw new Error("unreachable");
    }),
  ).rejects.toThrow("unreachable");
  await Promise.all(
    Array.from({ length: 3 }, () =>
      publish("hash", async () => {
        writes++;
        return true;
      }),
    ),
  );
  expect(writes).toBe(1);
});
