import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { monotonicFactory } from 'ulid';
import { tracer } from './powertools.js';
import { EVENT_SOURCE } from './events.js';
import { EntityNotFoundError } from './errors.js';

const TABLE_NAME = process.env.TABLE_NAME;

// ULIDs give each outbox record a unique, roughly time-ordered id. The monotonic
// factory keeps ids strictly increasing WITHIN a single Lambda process, which is
// enough to keep sort keys unique when several events are produced in the same
// millisecond. It is NOT a cross-process sequence — two containers can mint ids
// whose order doesn't match commit order — so eventId is a dedupe key, never an
// ordering guarantee.
const nextId = monotonicFactory();

// A single, traced DocumentClient is shared by every module. marshalling is
// configured to drop undefined values so callers can build sparse items without
// littering their code with conditional spreads.
const client = tracer.captureAWSv3Client(new DynamoDBClient({}));
export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true }
});

export const getItem = async (key, { consistentRead = false } = {}) => {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key, ConsistentRead: consistentRead }));
  return Item;
};

// Keep only the named attributes that actually have a value, so callers can
// assemble sparse items without a conditional spread per optional field.
export const pickDefined = (source, fields) =>
  Object.fromEntries(fields.filter((field) => source[field] !== undefined).map((field) => [field, source[field]]));

// True only when a write failed because a ConditionExpression was not satisfied.
// A TransactWriteCommand can also be cancelled for transient reasons
// (TransactionConflict, throttling, capacity) that surface as the same
// TransactionCanceledException, so we must inspect the cancellation reasons
// rather than trust the exception name — otherwise a transient failure would be
// misread as "already linked" / "not found" and its write silently lost. Both
// conditional meanings ("must exist" and "must not already exist") report the
// reason code ConditionalCheckFailed, so the caller interprets it in context.
export const isConditionalCheckFailure = (error) =>
  error?.name === 'ConditionalCheckFailedException' ||
  !!error?.CancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed');

// Runs a write guarded by an `attribute_exists(pk)` condition and turns the
// "row wasn't there" failure into a domain EntityNotFoundError, so no call site
// has to know how DynamoDB reports a failed condition.
export const assertFound = async (entity, id, write) => {
  try {
    return await write();
  } catch (error) {
    if (isConditionalCheckFailure(error)) throw new EntityNotFoundError(entity, id);
    throw error;
  }
};

// Builds a DynamoDB update from a plain description: `set` is a map of
// attribute -> value, `remove` is a list of attribute names to drop. Returns the
// three fields an Update operation needs, ready to spread in.
export const buildUpdateExpression = ({ set = {}, remove = [] }) => {
  const names = {};
  const values = {};

  const setClauses = Object.entries(set).map(([field, value]) => {
    names[`#${field}`] = field;
    values[`:${field}`] = value;
    return `#${field} = :${field}`;
  });
  const removeClauses = remove.map((field) => {
    names[`#${field}`] = field;
    return `#${field}`;
  });

  const expression = [
    setClauses.length ? `SET ${setClauses.join(', ')}` : '',
    removeClauses.length ? `REMOVE ${removeClauses.join(', ')}` : ''
  ]
    .filter(Boolean)
    .join(' ');

  return {
    UpdateExpression: expression,
    ExpressionAttributeNames: names,
    ...(setClauses.length && { ExpressionAttributeValues: values })
  };
};

export const query = async (params) => {
  const items = [];
  let ExclusiveStartKey;
  do {
    const result = await ddb.send(new QueryCommand({ TableName: TABLE_NAME, ...params, ExclusiveStartKey }));
    items.push(...(result.Items ?? []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
};

/**
 * The heart of the outbox pattern.
 *
 * Persists one or more domain writes and the domain events they produce inside a
 * single DynamoDB transaction. Because the entity change and the outbox records
 * commit atomically, we can never end up in a state where the data changed but
 * the event was lost (or vice versa). The outbox records land in the same table
 * and are picked up asynchronously by the outbox relay (see
 * src/handlers/outbox-relay.js), which forwards them to EventBridge.
 *
 * Delivery is at-least-once: the DynamoDB stream checkpoint is the relay's "ack",
 * and consumers must dedupe on `eventId`. Outbox records are NOT deleted on
 * publish — deleting would add a second failure mode (publish succeeds, delete
 * fails). Instead a TTL reclaims them after a replay/audit window.
 *
 * @param {object} params
 * @param {Array<object>} params.writes  Raw TransactWriteItems operations (Put/Update/Delete/ConditionCheck).
 * @param {Array<{detailType: string, aggregateId: string, detail: object, source?: string}>} [params.events]  Domain events to enqueue.
 */
export const transactWriteWithOutbox = async ({ writes, events = [] }) => {
  const TransactItems = [
    ...writes.map((write) => attachTableName(write)),
    ...events.map((event) => ({ Put: { TableName: TABLE_NAME, Item: toOutboxItem(event) } }))
  ];

  await ddb.send(new TransactWriteCommand({ TransactItems }));
};

const attachTableName = (write) => {
  const [operation, operationArgs] = Object.entries(write)[0];
  return { [operation]: { TableName: TABLE_NAME, ...operationArgs } };
};

// Outbox records live in the same single table. They are self-describing so the
// relay needs no knowledge of the domain, and carry a TTL so DynamoDB reclaims
// them automatically after the replay window has passed.
const OUTBOX_TTL_SECONDS = 24 * 60 * 60;

export const toOutboxItem = (event) => {
  const eventId = nextId();
  const now = Date.now();
  return {
    // Partition by aggregate id so an entity's events tend to land on one stream
    // shard (locality + best-effort in-order relay). This is NOT a hard ordering
    // guarantee: DynamoDB Streams only orders records for the SAME item, so
    // consumers must dedupe on eventId rather than treat it as a sequence.
    pk: `OUTBOX#${event.aggregateId}`,
    sk: `OUTBOX#${eventId}`,
    entityType: 'outbox',
    eventId,
    aggregateId: event.aggregateId,
    source: event.source ?? EVENT_SOURCE,
    detailType: event.detailType,
    detail: event.detail,
    occurredAt: new Date(now).toISOString(),
    ttl: Math.floor(now / 1000) + OUTBOX_TTL_SECONDS
  };
};

export { TABLE_NAME };
