### Spaces returned columns in text order of their ranks

- **What happened:** Read space, the Spaces REST API and `cld spaces show` listed a column ranked `10240` before one ranked `2048`, so their order differed from the board once ranks grew past four digits or turned negative after a move.
- **Root cause:** The queries selected `rank::text AS rank` and ended with `ORDER BY rank`. PostgreSQL resolves a bare name in `ORDER BY` to the output column first, so it sorted the text alias instead of the `BIGINT` column.
- **Error class:** An `ORDER BY` on a name that the select list re-aliases with a cast sorts by the cast value, not by the stored type.
- **Guard:** `packages/spaces/src/service/columns.integration.test.ts` checks numeric order and the tie-break for the column list and the default task column; Spaces queries now qualify the sort column with a table alias. None for other packages, because a static check cannot tell which casts change the order.
