import { expect } from "bun:test";
import { sql } from "bun";
import { testFor } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { adoptMigratedBoard, getUserSettings, saveUserSettings } from "./settings";

const dbTest = testFor("database");

const withUser = async (run: (userId: string) => Promise<void>) => {
  await migrate();
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO auth.users(uid, provider, profile, display_name)
    VALUES (${`dashboard-settings-${crypto.randomUUID()}`}, 'local', 'user', 'Dashboard settings test')
    RETURNING id
  `;
  try {
    await run(user!.id);
  } finally {
    await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
  }
};

const shortcut = { id: "handbook", kind: "link" as const, title: "Handbook", href: "https://example.com", icon: "ti ti-book" };

dbTest("a person without settings follows the default board; a saved board and its return to the default persist", async () => {
  await withUser(async (userId) => {
    expect(await getUserSettings(userId)).toEqual({ exists: false, settings: { shortcuts: [], board: null }, legacy: null });

    const board = [
      { key: "spaces/today", size: "large" as const },
      { key: "weather/current", size: "small" as const },
    ];
    await saveUserSettings(userId, { shortcuts: [shortcut], board });
    // The migration runs on every start and keeps what is stored.
    await migrate();
    expect(await getUserSettings(userId)).toEqual({ exists: true, settings: { shortcuts: [shortcut], board }, legacy: null });

    await saveUserSettings(userId, { shortcuts: [shortcut], board: [] });
    expect((await getUserSettings(userId)).settings.board).toEqual([]);

    await saveUserSettings(userId, { shortcuts: [], board: null });
    expect(await getUserSettings(userId)).toEqual({ exists: true, settings: { shortcuts: [], board: null }, legacy: null });
  });
});

dbTest("settings from before widgets had sizes become a board once, and never overwrite a board saved meanwhile", async () => {
  await withUser(async (userId) => {
    const layout = { widgets: [{ key: "weather/current", zone: "context", span: "standard" }], order: ["weather/current", "spaces/today"] };
    await sql`
      INSERT INTO dashboard.user_settings (user_id, gradient, hidden_widgets, shortcuts, widget_layout)
      VALUES (${userId}, 'sunset', ARRAY['quotes/quote']::text[], ${JSON.stringify([shortcut])}::jsonb, ${JSON.stringify(layout)}::jsonb)
    `;
    const stored = await getUserSettings(userId);
    expect(stored.settings).toEqual({ shortcuts: [shortcut], board: null });
    expect(stored.legacy).toEqual({
      hiddenWidgets: ["quotes/quote"],
      widgets: [{ key: "weather/current", zone: "context", span: "standard" }],
      order: ["weather/current", "spaces/today"],
    });

    const migrated = [
      { key: "spaces/today", size: "large" as const },
      { key: "weather/current", size: "small" as const },
    ];
    expect(await adoptMigratedBoard(userId, migrated)).toEqual({ shortcuts: [shortcut], board: migrated });
    expect(await getUserSettings(userId)).toEqual({ exists: true, settings: { shortcuts: [shortcut], board: migrated }, legacy: null });

    // A second conversion, such as from a page that loaded at the same time, keeps the board that is stored.
    expect(await adoptMigratedBoard(userId, [{ key: "notebooks/recent", size: "medium" }])).toEqual({
      shortcuts: [shortcut],
      board: migrated,
    });

    // A conversion that started before a return to the default board was saved does not bring the old board back,
    // and returns the shortcuts saved with it rather than the ones its page read before.
    const handbook = { ...shortcut, id: "handbook-2", title: "Handbook 2" };
    await saveUserSettings(userId, { shortcuts: [handbook], board: null });
    expect(await adoptMigratedBoard(userId, migrated)).toEqual({ shortcuts: [handbook], board: null });
    expect((await getUserSettings(userId)).settings.board).toBeNull();

    // Saving the default board again clears the old settings too, so they are not converted a second time.
    await sql`UPDATE dashboard.user_settings SET hidden_widgets = ARRAY['quotes/quote']::text[] WHERE user_id = ${userId}`;
    await saveUserSettings(userId, { shortcuts: [shortcut], board: null });
    expect((await getUserSettings(userId)).legacy).toBeNull();
  });
});
