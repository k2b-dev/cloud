# Template: daily database counter

Personal Code that keeps a daily counter. Copy to `code.ts`, check, test and
submit. The first database call creates the Code's database. Schema and data
survive later versions. This counts runs, so **Run again** increments it again.

<!-- check: personal -->
```ts
import { app, db } from "@sdk";

app.schedule({ cron: "0 8 * * *", timeZone: "UTC", name: "daily-counter", title: "Daily counter" }, async () => {
  await db.exec("CREATE TABLE IF NOT EXISTS counts (day TEXT PRIMARY KEY, total INTEGER NOT NULL)");
  const day = new Date().toISOString().slice(0, 10);
  await db.batch([
    { sql: "INSERT INTO counts(day, total) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET total = total + excluded.total", params: [day, 1] },
  ]);
  const rows = await db.query<{ day: string; total: number }>(
    "SELECT day, total FROM counts ORDER BY day DESC LIMIT ?", [7],
  );
  console.log(rows);
});
export default app;
```

Save this as `test/daily-counter.json`. Fixtures mock DB calls; they never create
or change the real Code database.

```json
{
  "version": 1,
  "name": "daily counter uses bound inputs",
  "now": 1794211200000,
  "seed": 7,
  "mocks": [
    {
      "operation": "db.exec",
      "target": null,
      "replies": [
        {
          "ok": true,
          "data": {
            "changes": 0
          }
        }
      ]
    },
    {
      "operation": "db.batch",
      "target": null,
      "replies": [
        {
          "ok": true,
          "data": [
            {
              "changes": 1
            }
          ]
        }
      ]
    },
    {
      "operation": "db.query",
      "target": null,
      "input": {
        "sql": "SELECT day, total FROM counts ORDER BY day DESC LIMIT ?",
        "params": [
          7
        ]
      },
      "replies": [
        {
          "ok": true,
          "data": [
            {
              "day": "2026-11-09",
              "total": 1
            }
          ]
        }
      ]
    }
  ],
  "runs": [
    {
      "entrypoint": "daily-counter",
      "expect": {
        "ok": true,
        "calls": [
          {
            "operation": "db.exec"
          },
          {
            "operation": "db.batch"
          },
          {
            "operation": "db.query"
          }
        ]
      }
    }
  ]
}
```

Keep values in bound parameters, including text from outside Cloud. Use an
application's capabilities for its domain records. This database belongs only
to this Code; another Code cannot open it.
