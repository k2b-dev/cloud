import { expect, test } from "bun:test";
import { checkSource } from "./principal-id-labels";

for (const id of [
  "userId",
  "groupId",
  "serviceAccountId",
  "principalId",
  "subjectId",
  "actorId",
  "authorId",
  "ownerId",
  "assigneeId",
  "memberId",
  "recipientId",
  "user_id",
  "actor_id",
  "service_account_id",
]) {
  test(`rejects ${id} as fallback or JSX text`, () => {
    for (const expression of [`name ?? row.${id}`, `label || ${id}`, `row.${id}`, `${id}!`]) {
      expect(checkSource("packages/app/src/Row.tsx", `const row = <span>{${expression}}</span>;`)).toHaveLength(1);
    }
  });
}

test("CLI human output has the same fallback guard", () => {
  expect(checkSource("packages/app/src/cli.ts", "ctx.print(name ?? person.userId);")).toHaveLength(1);
});

test("names, identity props, URLs, comparisons, and structured IDs are allowed", () => {
  expect(
    checkSource(
      "Row.tsx",
      `const row = <Avatar userId={userId} name={principalLabel(entry, locale)} href={userId}> {name ?? 'Unknown person'} </Avatar>; const data = { userId }; if (entry.userId !== userId) return;`,
    ),
  ).toEqual([]);
});

test("only a reasoned leading comment permits deliberate IDs", () => {
  expect(
    checkSource("Row.tsx", "// principal-id-labels: The technical trace identifies the recorded actor.\nconst label = name ?? actorId;"),
  ).toEqual([]);
  expect(
    checkSource(
      "Row.tsx",
      "const row = <code>{\n// principal-id-labels: The technical trace identifies the recorded actor.\nactorId}</code>;",
    ),
  ).toEqual([]);
  expect(checkSource("Row.tsx", "// principal-id-labels:\nconst row = <code>{actorId}</code>;")).toHaveLength(1);
  expect(checkSource("Row.tsx", "// unrelated comment\nconst row = <code>{actorId}</code>;")).toHaveLength(1);
});

test("createdBy and created_by can be names or translated field labels", () => {
  expect(checkSource("Row.tsx", "const row = <span>{b().createdBy}{t().createdBy}{row.createdBy ?? row.created_by}</span>;")).toEqual([]);
});

test("logical chains used as boolean conditions are allowed", () => {
  for (const chain of ["name || actorId || row.serviceAccountId", "(name ?? actorId) ?? row.serviceAccountId"]) {
    for (const source of [
      `if (${chain}) act();`,
      `while (${chain}) act();`,
      `do act(); while (${chain});`,
      `for (; ${chain};) act();`,
      `const row = (${chain}) ? <span /> : null;`,
      `const absent = !(${chain});`,
      `const present = Boolean(${chain});`,
      `const row = (${chain}) && <span />;`,
      `if (ready && (${chain})) act();`,
    ])
      expect(checkSource("Row.tsx", source)).toEqual([]);
  }
  expect(checkSource("Row.tsx", "const row = ready && (name ?? actorId);")).toHaveLength(1);
  expect(checkSource("Row.tsx", "const row = ready ? (name ?? actorId) : null;")).toHaveLength(1);
  expect(checkSource("Row.tsx", "const row = present(name ?? actorId);")).toHaveLength(1);
});

test("allow comments apply only to the nearest statement, JSX expression, attribute, or property", () => {
  const comment = "// principal-id-labels: Deliberate technical ID.\n";
  for (const source of [
    `${comment}function row() { return name ?? actorId; }`,
    `${comment}const row = () => name ?? actorId;`,
    `${comment}const row = <span>{name ?? actorId}</span>;`,
    `${comment}const row = { label: name ?? actorId };`,
    `${comment}const row = <span title={name ?? actorId} />;`,
  ])
    expect(checkSource("Row.tsx", source)).toHaveLength(1);
  for (const source of [
    `function row() { ${comment}return name ?? actorId; }`,
    `const row = { ${comment}label: name ?? actorId };`,
    `const row = <span title={${comment}name ?? actorId} />;`,
  ])
    expect(checkSource("Row.tsx", source)).toEqual([]);
});

test("test fixtures are excluded", () => {
  expect(checkSource("Row.behavior.test.tsx", "<span>{userId}</span>")).toEqual([]);
});
