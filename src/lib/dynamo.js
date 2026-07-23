import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import { tracer } from './powertools.js';

const TABLE_NAME = process.env.TABLE_NAME;

// A single, traced DocumentClient is shared by every module. marshalling is
// configured to drop undefined values so callers can build sparse items without
// littering their code with conditional spreads.
const client = tracer.captureAWSv3Client(new DynamoDBClient({}));
export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true }
});

export const getItem = async (key) => {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
  return Item;
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
 * @param {object} params
 * @param {Array<object>} params.writes  Raw TransactWriteItems operations (Put/Update/Delete/ConditionCheck).
 * @param {Array<{detailType: string, detail: object, source?: string}>} [params.events]  Domain events to enqueue.
 */
export const transactWriteWithOutbox = async ({ writes, events = [] }) => {
  const TransactItems = [
    ...writes.map((write) => attachTableName(write)),
    ...events.map((event) => ({ Put: { TableName: TABLE_NAME, Item: toOutboxItem(event) } }))
  ];

  await ddb.send(new TransactWriteCommand({ TransactItems }));
};

const attachTableName = (write) => {
  const [operation, body] = Object.entries(write)[0];
  return { [operation]: { TableName: TABLE_NAME, ...body } };
};

// Outbox records live in the same single table. They are self-describing so the
// relay needs no knowledge of the domain, and carry a TTL so DynamoDB reclaims
// them automatically a day after they are published.
const OUTBOX_TTL_SECONDS = 24 * 60 * 60;

export const toOutboxItem = (event) => {
  const eventId = ulid();
  const now = Math.floor(Date.now() / 1000);
  return {
    pk: `OUTBOX#${eventId}`,
    sk: `OUTBOX#${eventId}`,
    entityType: 'outbox',
    eventId,
    source: event.source ?? 'ghu.api',
    detailType: event.detailType,
    detail: event.detail,
    createdAt: new Date().toISOString(),
    ttl: now + OUTBOX_TTL_SECONDS
  };
};

export { TABLE_NAME };
