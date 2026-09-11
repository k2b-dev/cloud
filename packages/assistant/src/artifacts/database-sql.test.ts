import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { safeQuery } from "./database-sql";

test("resource SELECT accepts bound values and bounds real SQLite results", () => {
  const db=new Database(":memory:");
  try {
    db.exec("CREATE TABLE records(id INTEGER PRIMARY KEY, title TEXT, amount INTEGER)");
    const insert=db.prepare("INSERT INTO records(title,amount) VALUES (?,?)");
    db.transaction(()=>{for(let i=0;i<1010;i++)insert.run("Item "+i,i);})();
    expect(db.query(safeQuery("SELECT title, amount FROM records WHERE amount = ?;",1)).all(42)).toEqual([{title:"Item 42",amount:42}]);
    expect(db.query(safeQuery("SELECT * FROM records",0)).all()).toHaveLength(1001);
    expect(db.query(safeQuery("SELECT '?' AS title",0)).get()).toEqual({title:"?"});
  } finally {db.close();}
});

test("resource SQL rejects writes, multiple statements, internal objects and unapproved functions", () => {
  for(const sql of [
    "DELETE FROM records", "INSERT INTO records(title) VALUES ('x')", "PRAGMA journal_mode=WAL",
    "SELECT 1; DROP TABLE records", "WITH x AS (SELECT 1) SELECT * FROM x", "SELECT * FROM sqlite_master",
    'SELECT * FROM "sqlite_master"', "SELECT * FROM pragma_table_info('records')", "SELECT load_extension('x')",
    "SELECT readfile('/etc/passwd')", "SELECT 1 -- trailing comment", "SELECT /* hidden */ 1",
  ])expect(()=>safeQuery(sql)).toThrow("DB_SQL_UNSUPPORTED");
  expect(()=>safeQuery("SELECT ?",0)).toThrow("DB_SQL_PARAMS");
  expect(()=>safeQuery("SELECT '?'",1)).toThrow("DB_SQL_PARAMS");
});
