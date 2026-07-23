import { ulid } from 'ulid';
import { getItem, query, transactWriteWithOutbox } from '../dynamo.js';
import { holeKey, linkKey, GSI1, GSI2, HOLE_COLLECTION, locationKey } from '../keys.js';
import { DetailType, domainEvent } from '../events.js';

const HOLE_FIELDS = ['description', 'location', 'status', 'gopherId', 'comment'];
const OPTIONAL_FIELDS = ['gopherId', 'comment'];

const pick = (source, fields) =>
  Object.fromEntries(fields.filter((field) => source[field] !== undefined).map((field) => [field, source[field]]));

export const toHole = (item) => {
  if (!item) return undefined;
  return {
    id: item.id,
    description: item.description,
    location: item.location,
    status: item.status ?? 'visible',
    ...pick(item, ['gopherId', 'comment']),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
};

export const createHole = async (input) => {
  const id = ulid();
  const now = new Date().toISOString();
  const item = {
    ...holeKey(id),
    entityType: 'hole',
    id,
    ...pick(input, HOLE_FIELDS),
    status: input.status ?? 'visible',
    createdAt: now,
    updatedAt: now,
    GSI1PK: HOLE_COLLECTION,
    GSI1SK: now,
    GSI2PK: locationKey(input.location),
    GSI2SK: holeKey(id).sk
  };

  await transactWriteWithOutbox({
    writes: [{ Put: { Item: item, ConditionExpression: 'attribute_not_exists(pk)' } }],
    events: [
      domainEvent(DetailType.HoleCreated, {
        id,
        description: item.description,
        location: item.location,
        status: item.status,
        gopherId: item.gopherId
      })
    ]
  });

  return toHole(item);
};

export const getHole = async (id) => toHole(await getItem(holeKey(id)));

export const listHoles = async (status) => {
  const items = await query({
    IndexName: GSI1,
    KeyConditionExpression: 'GSI1PK = :collection',
    ...(status && {
      FilterExpression: '#status = :status',
      ExpressionAttributeNames: { '#status': 'status' }
    }),
    ExpressionAttributeValues: { ':collection': HOLE_COLLECTION, ...(status && { ':status': status }) }
  });
  return items.map(toHole);
};

export const updateHole = async (id, input, { replace = false } = {}) => {
  const fields = pick(input, HOLE_FIELDS);
  const names = { '#updatedAt': 'updatedAt' };
  const values = { ':updatedAt': new Date().toISOString() };
  const sets = ['#updatedAt = :updatedAt'];
  const removes = [];

  for (const [key, value] of Object.entries(fields)) {
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    sets.push(`#${key} = :${key}`);
  }

  // Keep the location index in sync whenever the physical location moves.
  if (fields.location) {
    names['#GSI2PK'] = 'GSI2PK';
    values[':GSI2PK'] = locationKey(fields.location);
    sets.push('#GSI2PK = :GSI2PK');
  }

  // A full replace (PUT) clears optional attributes the caller omitted.
  if (replace) {
    for (const field of OPTIONAL_FIELDS) {
      if (fields[field] === undefined) {
        names[`#${field}`] = field;
        removes.push(`#${field}`);
      }
    }
  }

  const updateExpression = [`SET ${sets.join(', ')}`, removes.length ? `REMOVE ${removes.join(', ')}` : '']
    .filter(Boolean)
    .join(' ');

  const events = [domainEvent(DetailType.HoleUpdated, { id, changes: Object.keys(fields) })];
  if (fields.status !== undefined) {
    events.push(domainEvent(DetailType.HoleStatusChanged, { id, status: fields.status }));
  }

  await transactWriteWithOutbox({
    writes: [
      {
        Update: {
          Key: holeKey(id),
          ConditionExpression: 'attribute_exists(pk)',
          UpdateExpression: updateExpression,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values
        }
      }
    ],
    events
  });
};

export const updateHoleStatus = async (id, status) => {
  await transactWriteWithOutbox({
    writes: [
      {
        Update: {
          Key: holeKey(id),
          ConditionExpression: 'attribute_exists(pk)',
          UpdateExpression: 'SET #status = :status, #updatedAt = :now',
          ExpressionAttributeNames: { '#status': 'status', '#updatedAt': 'updatedAt' },
          ExpressionAttributeValues: { ':status': status, ':now': new Date().toISOString() }
        }
      }
    ],
    events: [domainEvent(DetailType.HoleStatusChanged, { id, status })]
  });
};

// ---- Linking (used by the choreography consumer, not the API directly) ----

// Find holes that share a physical location with a gopher, so a newly reported
// gopher can be auto-linked to the holes already known at that spot.
export const findHolesAtLocation = async (location) => {
  const pk = locationKey(location);
  if (!pk) return [];
  const items = await query({
    IndexName: GSI2,
    KeyConditionExpression: 'GSI2PK = :pk',
    ExpressionAttributeValues: { ':pk': pk }
  });
  return items.map(toHole);
};

export const linkGopherToHole = async ({ gopherId, holeId, description, status }) => {
  const now = new Date().toISOString();
  await transactWriteWithOutbox({
    writes: [
      {
        Put: {
          Item: {
            ...linkKey(gopherId, holeId),
            entityType: 'link',
            gopherId,
            holeId,
            description,
            status: status ?? 'visible',
            createdAt: now,
            GSI1PK: `HOLE#${holeId}`,
            GSI1SK: `GOPHER#${gopherId}`
          },
          ConditionExpression: 'attribute_not_exists(pk)'
        }
      }
    ],
    events: [domainEvent(DetailType.GopherHoleLinked, { gopherId, holeId })]
  });
};

// Reverse lookup: every gopher currently linked to a given hole.
export const findLinksForHole = async (holeId) =>
  query({
    IndexName: GSI1,
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `HOLE#${holeId}` }
  });

// Propagate a hole's new status onto the denormalized copies held on each link.
export const syncLinkStatus = async (holeId, status) => {
  const links = await findLinksForHole(holeId);
  await Promise.all(
    links.map((link) =>
      transactWriteWithOutbox({
        writes: [
          {
            Update: {
              Key: linkKey(link.gopherId, holeId),
              UpdateExpression: 'SET #status = :status',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':status': status }
            }
          }
        ]
      })
    )
  );
  return links.length;
};
