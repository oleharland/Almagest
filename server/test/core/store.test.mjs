import { createMemoryStore } from '../../src/core/store/memory.mjs';
import { createSqliteStore } from '../../src/core/store/sqlite.mjs';
import { storeConformance } from './store-conformance.mjs';

// One suite, every driver: the memory store is only a valid test double while
// it behaves exactly like sqlite. Postgres runs the same suite in
// store-postgres.test.mjs when ALMAGEST_TEST_PG_URL is set.
storeConformance('memory', createMemoryStore);
storeConformance('sqlite', () => createSqliteStore({ file: ':memory:' }));
