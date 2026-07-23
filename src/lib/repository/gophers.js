import { ulid } from 'ulid';
import { getItem, query, transactWriteWithOutbox } from '../dynamo.js';
import { gopherKey, gopherStatusKey, GSI1, GOPHER_COLLECTION, LINK_PREFIX } from '../keys.js';
import { DetailType, domainEvent } from '../events.js';

// Attributes a caller is allowed to set on a gopher. Anything else in the
// request body is ignored, which keeps the write path safe from unexpected input.
const GOPHER_FIELDS = ['name', 'type', 'sex', 'picture', 'status', 'color', 'location', 'comment'];

const pick = (source, fields) =>
  Object.fromEntries(fields.filter((field) => source[field] !== undefined).map((field) => [field, source[field]]));

export const toGopher = (item) => {
  if (!item) return undefined;
  return {
    id: item.id,
    name: item.name,
    location: item.location,
    status: item.status ?? 'unknown',
    timesSeen: item.timesSeen ?? 0,
    ...pick(item, ['type', 'sex', 'picture', 'color', 'comment']),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
};

export const createGopher = async (input) => {
  const id = ulid();
  const now = new Date().toISOString();
  const item = {
    ...gopherKey(id),
    entityType: 'gopher',
    id,
    timesSeen: 0,
    ...pick(input, GOPHER_FIELDS),
    status: input.status ?? 'unknown',
    createdAt: now,
    updatedAt: now,
    GSI1PK: GOPHER_COLLECTION,
    GSI1SK: now
  };

  await transactWriteWithOutbox({
    writes: [{ Put: { Item: item, ConditionExpression: 'attribute_not_exists(pk)' } }],
    events: [domainEvent(DetailType.GopherCreated, id, { id, name: item.name, location: item.location })]
  });

  return toGopher(item);
};

export const getGopher = async (id) => toGopher(await getItem(gopherKey(id)));

export const listGophers = async () => {
  const items = await query({
    IndexName: GSI1,
    KeyConditionExpression: 'GSI1PK = :collection',
    ExpressionAttributeValues: { ':collection': GOPHER_COLLECTION }
  });
  return items.map(toGopher);
};

export const updateGopher = async (id, patch) => {
  const fields = pick(patch, GOPHER_FIELDS);
  const { updateExpression, names, values } = buildUpdate(fields);

  await transactWriteWithOutbox({
    writes: [
      {
        Update: {
          Key: gopherKey(id),
          ConditionExpression: 'attribute_exists(pk)',
          UpdateExpression: updateExpression,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values
        }
      }
    ],
    events: [domainEvent(DetailType.GopherUpdated, id, { id, changes: Object.keys(fields) })]
  });
};

export const deleteGopher = async (id) => {
  await transactWriteWithOutbox({
    writes: [{ Delete: { Key: gopherKey(id), ConditionExpression: 'attribute_exists(pk)' } }],
    events: [domainEvent(DetailType.GopherDeleted, id, { id })]
  });
};

export const addGopherStatus = async (id, status) => {
  const statusId = ulid();
  const now = new Date().toISOString();

  await transactWriteWithOutbox({
    writes: [
      {
        Update: {
          Key: gopherKey(id),
          ConditionExpression: 'attribute_exists(pk)',
          UpdateExpression: 'SET #status = :status, #updatedAt = :now',
          ExpressionAttributeNames: { '#status': 'status', '#updatedAt': 'updatedAt' },
          ExpressionAttributeValues: { ':status': status, ':now': now }
        }
      },
      {
        Put: {
          Item: {
            ...gopherStatusKey(id, statusId),
            entityType: 'gopherStatus',
            gopherId: id,
            status,
            createdAt: now
          }
        }
      }
    ],
    events: [domainEvent(DetailType.GopherStatusChanged, id, { id, status })]
  });
};

// A gopher's linked holes are stored under its own partition, so this is a
// simple begins_with query with no index needed.
export const getGopherHoles = async (id) => {
  const items = await query({
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :link)',
    ExpressionAttributeValues: { ':pk': gopherKey(id).pk, ':link': LINK_PREFIX }
  });
  return items.map((item) => ({ id: item.holeId, description: item.description, status: item.status }));
};

// Shared by both the API (PATCH) and keeps the SET expression building in one place.
export const buildUpdate = (fields) => {
  const names = { '#updatedAt': 'updatedAt' };
  const values = { ':updatedAt': new Date().toISOString() };
  const assignments = ['#updatedAt = :updatedAt'];

  for (const [key, value] of Object.entries(fields)) {
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    assignments.push(`#${key} = :${key}`);
  }

  return { updateExpression: `SET ${assignments.join(', ')}`, names, values };
};
