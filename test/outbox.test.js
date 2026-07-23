import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { marshall } from '@aws-sdk/util-dynamodb';

process.env.TABLE_NAME = 'test-table';
process.env.EVENT_BUS_NAME = 'test-bus';
process.env.POWERTOOLS_SERVICE_NAME = 'ghu-test';
process.env.POWERTOOLS_METRICS_NAMESPACE = 'ghu-test';
process.env.AWS_REGION = 'us-east-1';

const { toOutboxItem } = await import('../src/lib/dynamo.js');
const { handler } = await import('../src/handlers/outbox-relay.js');

const eventBridgeMock = mockClient(EventBridgeClient);
beforeEach(() => eventBridgeMock.reset());

const streamRecord = (outboxItem, sequenceNumber) => ({
  eventName: 'INSERT',
  dynamodb: { SequenceNumber: sequenceNumber, NewImage: marshall(outboxItem, { removeUndefinedValues: true }) }
});

const outbox = (aggregateId, detailType = 'gopher.created') =>
  toOutboxItem({ detailType, aggregateId, detail: { id: aggregateId } });

test('toOutboxItem partitions by aggregate and carries the envelope', () => {
  const item = toOutboxItem({ detailType: 'gopher.created', aggregateId: 'g1', detail: { id: 'g1' } });
  assert.equal(item.pk, 'OUTBOX#g1');
  assert.equal(item.entityType, 'outbox');
  assert.equal(item.aggregateId, 'g1');
  assert.ok(item.eventId && item.sk === `OUTBOX#${item.eventId}`);
  assert.ok(item.ttl > Math.floor(Date.now() / 1000));
});

test('outbox sort keys are monotonic within the same millisecond', () => {
  const first = toOutboxItem({ detailType: 'x', aggregateId: 'g1', detail: {} });
  const second = toOutboxItem({ detailType: 'x', aggregateId: 'g1', detail: {} });
  assert.ok(second.sk > first.sk, 'second event must sort after the first');
});

test('publishes every record and reports no failures on success', async () => {
  eventBridgeMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [{ EventId: 'ok' }] });

  const event = { Records: [streamRecord(outbox('g1'), '1'), streamRecord(outbox('g2'), '2')] };
  const result = await handler(event, { awsRequestId: 'r', getRemainingTimeInMillis: () => 1000 });

  assert.deepEqual(result.batchItemFailures, []);
  assert.equal(eventBridgeMock.commandCalls(PutEventsCommand).length, 2);
});

test('treats PutEvents FailedEntryCount > 0 as a failure (no silent loss)', async () => {
  eventBridgeMock
    .on(PutEventsCommand)
    .resolvesOnce({ FailedEntryCount: 1, Entries: [{ ErrorCode: 'ThrottlingException', ErrorMessage: 'slow down' }] });

  const event = { Records: [streamRecord(outbox('g1'), '1')] };
  const result = await handler(event, { awsRequestId: 'r', getRemainingTimeInMillis: () => 1000 });

  assert.deepEqual(result.batchItemFailures, [{ itemIdentifier: '1' }]);
});

test('stops at the first failure and does not publish later records (preserves order)', async () => {
  eventBridgeMock
    .on(PutEventsCommand)
    .resolvesOnce({ FailedEntryCount: 0, Entries: [{ EventId: 'ok' }] }) // record 1 succeeds
    .rejectsOnce(new Error('network blip')); // record 2 fails; record 3 must not be attempted

  const event = {
    Records: [streamRecord(outbox('g1'), '1'), streamRecord(outbox('g1'), '2'), streamRecord(outbox('g1'), '3')]
  };
  const result = await handler(event, { awsRequestId: 'r', getRemainingTimeInMillis: () => 1000 });

  // Only the first failed sequence number is reported; the stream re-delivers
  // from there, so record 3 is never published ahead of record 2.
  assert.deepEqual(result.batchItemFailures, [{ itemIdentifier: '2' }]);
  assert.equal(eventBridgeMock.commandCalls(PutEventsCommand).length, 2);
});
