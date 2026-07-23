import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

process.env.TABLE_NAME = 'test-table';
process.env.IDEMPOTENCY_TABLE_NAME = 'test-idempotency';
process.env.POWERTOOLS_SERVICE_NAME = 'ghu-test';
process.env.POWERTOOLS_METRICS_NAMESPACE = 'ghu-test';
process.env.AWS_REGION = 'us-east-1';

const { onGopherCreated } = await import('../src/handlers/choreography.js');

const ddbMock = mockClient(DynamoDBDocumentClient);
beforeEach(() => ddbMock.reset());

const location = { latitude: '1', longitude: '2' };
const twoHolesAtLocation = {
  Items: [
    { id: 'h1', description: 'by the hydrant', location, status: 'visible' },
    { id: 'h2', description: 'under the oak', location, status: 'visible' }
  ]
};

const conditionalCheckFailure = () =>
  Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException' });

test('links the gopher to every hole found at its location', async () => {
  ddbMock.on(QueryCommand).resolves(twoHolesAtLocation);
  ddbMock.on(TransactWriteCommand).resolves({});

  await onGopherCreated({ id: 'g1', location });

  assert.equal(ddbMock.commandCalls(TransactWriteCommand).length, 2);
});

test('swallows already-linked conflicts without failing the event', async () => {
  ddbMock.on(QueryCommand).resolves(twoHolesAtLocation);
  ddbMock.on(TransactWriteCommand).rejects(conditionalCheckFailure());

  await assert.doesNotReject(() => onGopherCreated({ id: 'g1', location }));
});

test('waits for all links then throws so the event is redelivered when one genuinely fails', async () => {
  ddbMock.on(QueryCommand).resolves(twoHolesAtLocation);
  ddbMock
    .on(TransactWriteCommand)
    .resolvesOnce({}) // first link commits
    .rejectsOnce(Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' }));

  await assert.rejects(
    () => onGopherCreated({ id: 'g1', location }),
    (error) => error instanceof AggregateError
  );
  // Both links were attempted (allSettled) even though one failed.
  assert.equal(ddbMock.commandCalls(TransactWriteCommand).length, 2);
});
