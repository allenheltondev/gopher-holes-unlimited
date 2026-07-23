import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

process.env.TABLE_NAME = 'test-table';
process.env.IDEMPOTENCY_TABLE_NAME = 'test-idempotency';
process.env.POWERTOOLS_SERVICE_NAME = 'ghu-test';
process.env.POWERTOOLS_METRICS_NAMESPACE = 'ghu-test';
process.env.AWS_REGION = 'us-east-1';

const { onGopherCreated, onHoleCreated, onHoleStatusChanged } = await import('../src/handlers/choreography.js');
const { findHolesAtLocation } = await import('../src/lib/repository/holes.js');

const ddbMock = mockClient(DynamoDBDocumentClient);
beforeEach(() => ddbMock.reset());

const location = { latitude: '1', longitude: '2' };

// A cancelled transaction whose reason is a failed condition — i.e. already linked.
const conditionalCheckFailure = () =>
  Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'ConditionalCheckFailed' }]
  });

// A cancelled transaction for a transient reason — must NOT be swallowed.
const transientConflict = () =>
  Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'TransactionConflict' }]
  });

// Location-rendezvous member records (base-table items carrying only ids).
const twoHoleMembers = { Items: [{ holeId: 'h1' }, { holeId: 'h2' }] };
const twoGopherMembers = { Items: [{ gopherId: 'g1' }, { gopherId: 'g2' }] };
const holeItem = { Item: { id: 'h1', description: 'by the hydrant', location, status: 'visible' } };

test('onGopherCreated links the gopher to every hole at its location', async () => {
  ddbMock.on(QueryCommand).resolves(twoHoleMembers);
  ddbMock.on(GetCommand).resolves(holeItem);
  ddbMock.on(TransactWriteCommand).resolves({});

  await onGopherCreated({ id: 'g1', location });

  assert.equal(ddbMock.commandCalls(TransactWriteCommand).length, 2);
});

test('onGopherCreated swallows already-linked conflicts without failing the event', async () => {
  ddbMock.on(QueryCommand).resolves(twoHoleMembers);
  ddbMock.on(GetCommand).resolves(holeItem);
  ddbMock.on(TransactWriteCommand).rejects(conditionalCheckFailure());

  await assert.doesNotReject(() => onGopherCreated({ id: 'g1', location }));
});

test('onGopherCreated does NOT swallow a transient transaction conflict', async () => {
  ddbMock.on(QueryCommand).resolves(twoHoleMembers);
  ddbMock.on(GetCommand).resolves(holeItem);
  ddbMock.on(TransactWriteCommand).rejects(transientConflict());

  await assert.rejects(() => onGopherCreated({ id: 'g1', location }), (error) => error instanceof AggregateError);
});

test('onGopherCreated waits for all links then throws when one genuinely fails', async () => {
  ddbMock.on(QueryCommand).resolves(twoHoleMembers);
  ddbMock.on(GetCommand).resolves(holeItem);
  ddbMock
    .on(TransactWriteCommand)
    .resolvesOnce({})
    .rejectsOnce(Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' }));

  await assert.rejects(() => onGopherCreated({ id: 'g1', location }), (error) => error instanceof AggregateError);
  assert.equal(ddbMock.commandCalls(TransactWriteCommand).length, 2);
});

test('onHoleCreated links the hole to gophers already at its location (symmetric)', async () => {
  ddbMock.on(QueryCommand).resolves(twoGopherMembers);
  ddbMock.on(TransactWriteCommand).resolves({});

  await onHoleCreated({ id: 'h9', description: 'fresh dig', status: 'visible', location });

  assert.equal(ddbMock.commandCalls(TransactWriteCommand).length, 2);
});

test('onHoleStatusChanged reads the hole strongly-consistently and syncs its CURRENT status', async () => {
  // Event says "filled" but the hole item's current status is "visible" (a newer
  // event already won). Re-reading with ConsistentRead keeps the links correct
  // regardless of event ordering.
  ddbMock.on(GetCommand).resolves({ Item: { id: 'h1', description: 'd', location, status: 'visible' } });
  ddbMock.on(QueryCommand).resolves({ Items: [{ gopherId: 'g1', holeId: 'h1' }] });
  ddbMock.on(TransactWriteCommand).resolves({});

  await onHoleStatusChanged({ id: 'h1', status: 'filled' });

  const getInput = ddbMock.commandCalls(GetCommand)[0].args[0].input;
  assert.equal(getInput.ConsistentRead, true);
  const update = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems[0].Update;
  assert.equal(update.ExpressionAttributeValues[':status'], 'visible');
});

test('findHolesAtLocation discovers via a strongly-consistent base-table read (no GSI)', async () => {
  ddbMock.on(QueryCommand).resolves({ Items: [{ holeId: 'h1' }] });
  ddbMock.on(GetCommand).resolves(holeItem);

  await findHolesAtLocation(location);

  const queryInput = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
  assert.equal(queryInput.ConsistentRead, true);
  assert.equal(queryInput.IndexName, undefined); // base table, not an eventually-consistent GSI
});
