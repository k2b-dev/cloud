/**
 * Recovery allowance shared by NATS and settings startup. After a host or stack
 * restart, dependencies need time to recover and elect leaders. Failed recovery
 * attempts stop startup when this allowance is spent, so the process supervisor
 * can restart it. A healthy settings attempt still runs after NATS recovery.
 */
export const DEPENDENCY_STARTUP_BUDGET_MS = 5 * 60_000;
