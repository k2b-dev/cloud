### Keep guard digits before rounding a power to its final scale

- **What happened:** Grids previews and SQL disagreed for `POW('5.769230769230769', -2)`, so the same computed expression could produce different captured values.
- **Root cause:** PostgreSQL first rounded the reciprocal power to 17 fractional places as `0.03004444444444445`. Rounding that midpoint again to the formula's 16-place scale produced `0.0300444444444445` instead of `0.0300444444444444`. The SQL helper requested only the target scale, allowing PostgreSQL's magnitude-based scale selection to introduce this double rounding.
- **Error class:** Rounding an intermediate decimal result before applying the final scale changes the last retained digit.
- **Guard:** Tests: `numeric-power-sql.integration.test.ts` checks explicit frozen results through the formula evaluator and compiled SQL, alongside the deterministic generated cases. `numeric.test.ts` pins negative powers, normalized trailing zeroes, signed bases, higher input scales and the 1,000-place boundary. The SQL helper requests 16 guard places, within PostgreSQL's 1,000-place limit, before the final rounding.
