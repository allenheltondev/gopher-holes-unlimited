import { makeIdempotent, IdempotencyConfig } from '@aws-lambda-powertools/idempotency';
import { DynamoDBPersistenceLayer } from '@aws-lambda-powertools/idempotency/dynamodb';

// A dedicated table (with TTL) stores idempotency records so retried create
// requests never produce duplicate gophers or holes. Idempotency is opt-in:
// callers activate it by sending an `Idempotency-Key` header. When the header is
// absent we skip the check rather than throw, so the API stays easy to call.
const persistenceStore = new DynamoDBPersistenceLayer({ tableName: process.env.IDEMPOTENCY_TABLE_NAME });

const config = new IdempotencyConfig({
  eventKeyJmesPath: 'idempotencyKey',
  throwOnNoIdempotencyKey: false,
  expiresAfterSeconds: 60 * 60
});

/**
 * Wraps a write function so it becomes idempotent on the caller-supplied key.
 * The wrapped function is invoked as `fn({ idempotencyKey, payload })`; only the
 * key participates in de-duplication, and the full result is replayed on repeats.
 */
export const withIdempotency = (fn) =>
  makeIdempotent(async ({ payload }) => fn(payload), { persistenceStore, config });
