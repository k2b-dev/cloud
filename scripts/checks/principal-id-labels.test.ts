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

test("rejects the original PermissionEditor and Grids label functions", () => {
  expect(
    checkSource(
      "Row.tsx",
      `const getEntryDisplayName = (entry, t, locale) => {
    if (entry.principal.type === "authenticated") return t.allUsers;
    if (entry.displayName) return entry.displayName;
    if (entry.principal.type === "user") return entry.principal.userId;
    if (entry.principal.type === "service_account") return entry.principal.serviceAccountId;
    return entry.principal.groupId;
  };`,
    ),
  ).toHaveLength(3);
  expect(
    checkSource(
      "Row.tsx",
      `export const entryLabel = (entry, a, b): string => {
    if (entry.principal.type === "authenticated") return a.allUsers;
    if (entry.displayName) return entry.displayName;
    if (entry.principal.type === "user") return entry.principal.userId;
    return entry.principal.serviceAccountId;
  };`,
    ),
  ).toHaveLength(2);
});

test("rejects ID returns in all named label function forms", () => {
  for (const source of [
    "function actorName(row) { return row.actorId; }",
    "const row = { label() { return this.userId; } };",
    "class Row { label() { return this.userId; } }",
    "const actorName = (row) => row.actorId;",
    "const actorName = ((row) => row.actorId);",
    "const actorName = function(row) { return row.actorId; };",
    "let principalTitle = function technicalKey(row) { return row.principalId; };",
    "const row = { displayName: (entry) => entry.userId };",
    "const row = { text: function(entry) { return entry.userId; } };",
    "function ACTORNAME(row) { return (row.actorId!); }",
  ])
    expect(checkSource("Row.tsx", source)).toHaveLength(1);
});

test("rejects bare IDs and nested fallback leaves in text positions", () => {
  for (const expression of ["actorId", "(row.userId!)", "name ?? (ready ? `${row.userId}` : name)", "name || (row.userId!)"])
    for (const source of [
      `const row = <span title={${expression}} />;`,
      `const row = { "description": ${expression} };`,
      `function actorName() { return ${expression}; }`,
    ])
      expect(checkSource("Row.tsx", source)).toHaveLength(1);
});

test("rejects ID branches and template spans in text positions", () => {
  for (const expression of ["name ? name : row.userId", "name ? row.userId : name", "`${row.userId}`", "`${name ? row.userId : name}`"])
    for (const source of [
      `const row = <span>{${expression}}</span>;`,
      ...["label", "title", "aria-label", "aria-description", "alt", "placeholder"].map(
        (attribute) => `const row = <span ${attribute}={${expression}} />;`,
      ),
      ...["label", "title", "displayName", "description"].map((property) => `const row = { ${property}: ${expression} };`),
      `const actorName = () => ${expression};`,
      `function actorName() { return ${expression}; }`,
      `const label = name ?? (${expression});`,
      `const label = name || (${expression});`,
    ])
      expect(checkSource("Row.tsx", source)).toHaveLength(1);
  expect(checkSource("Row.tsx", "const row = <span title={`by ${actorId}`} />;")).toHaveLength(1);
  for (const method of ["print", "error"])
    expect(checkSource("packages/app/src/cli.ts", `ctx.${method}(\`by \${name ? name : row.userId}\`);`)).toHaveLength(1);
  expect(checkSource("packages/app/src/cli.ts", "ctx.print({ userId });")).toEqual([]);
});

test("data selection and principal label resolution are allowed", () => {
  for (const source of [
    'const principalId = p.type === "user" ? p.userId : p.groupId;',
    "function principalKey(p) { return p.userId; }",
    "const userIdOf = (p) => p.userId;",
    "const entryLabel = (entry) => principalLabel(entry, locale);",
    "function actorName(row) { return principalLabel(row, locale); }",
    "const actorName = () => { const principalKey = () => { return row.userId; }; return principalKey(); };",
    "const row = <Avatar userId={ready ? row.userId : other.userId} href={`${row.userId}`} />;",
    "const row = <span>{name ? row.userId === userId : Boolean(row.userId)}</span>;",
    "const row = <span>{name ? { userId } : null}</span>;",
    "ctx.print({ userId });",
  ])
    expect(checkSource("Row.tsx", source)).toEqual([]);
});

test("new text positions retain local allow-comment boundaries", () => {
  const comment = "// principal-id-labels: Deliberate technical ID.\n";
  for (const source of [
    `function actorName(row) { ${comment}return row.actorId; return row.actorId; }`,
    `${comment}function actorName(row) { return row.actorId; }`,
    `${comment}const actorName = (row) => row.actorId;`,
    `${comment}const row = <span title={actorId} />;`,
    `const row = <span ${comment}title={actorId} />;`,
    `${comment}const row = { label: actorId };`,
  ])
    expect(checkSource("Row.tsx", source)).toHaveLength(1);
  for (const source of [
    `function actorName(row) { ${comment}return row.actorId; }`,
    `const row = <span title={${comment}\`by \${actorId}\`} />;`,
    `const row = { ${comment}label: ready ? name : actorId };`,
    `const row = <span>{${comment}ready ? name : actorId}</span>;`,
  ])
    expect(checkSource("Row.tsx", source)).toEqual([]);
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
