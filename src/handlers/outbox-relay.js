import middy from '@middy/core';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { logger, metrics, tracer } from '../lib/powertools.js';

// The outbox relay is the "message relay" half of the transactional outbox
// pattern. DynamoDB Streams delivers newly-committed outbox records here, and we
// forward each one to EventBridge. An event-source mapping filter (see
// template.yaml) ensures only outbox INSERTs reach this function.
//
// Reliability properties this handler is responsible for:
//
//   * No lost events. PutEvents can return HTTP 200 while individual entries
//     fail (throttling, etc.); we inspect FailedEntryCount and treat any failure
//     as a record failure so the stream re-delivers it.
//   * In-order, at-least-once delivery. DynamoDB Streams is an ORDERED source:
//     records in a shard arrive in sequence, and on partial failure the service
//     re-delivers from the lowest un-acked sequence number. To honor that we
//     process records sequentially and STOP at the first failure, reporting it
//     via `batchItemFailures`. We never publish a later event before an earlier
//     one in the same shard has succeeded — preserving per-aggregate order.
//   * Bounded head-of-line blocking. Stopping on failure means a poison record
//     would block its shard, so the event-source mapping caps retries and routes
//     exhausted records to a DLQ (see template.yaml), letting the shard advance.
//
// Consumers still receive duplicates (at-least-once) and must dedupe on
// `eventId`; EventBridge itself does not guarantee ordering, so consumers that
// need strict order should sequence on the monotonic `eventId` / `occurredAt`.

const eventBridge = tracer.captureAWSv3Client(new EventBridgeClient({}));
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME;

export const publishRecord = async (record) => {
  const image = record.dynamodb?.NewImage;
  if (!image) return;

  const outbox = unmarshall(image);
  if (outbox.entityType !== 'outbox') return; // defensive: filter should exclude these

  const result = await eventBridge.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: EVENT_BUS_NAME,
          Source: outbox.source,
          DetailType: outbox.detailType,
          Detail: JSON.stringify({
            eventId: outbox.eventId,
            aggregateId: outbox.aggregateId,
            occurredAt: outbox.occurredAt,
            ...outbox.detail
          })
        }
      ]
    })
  );

  // A 200 response does not mean success — check for per-entry failures.
  if (result.FailedEntryCount && result.FailedEntryCount > 0) {
    const [entry] = result.Entries ?? [];
    throw new Error(
      `EventBridge rejected event ${outbox.eventId}: ${entry?.ErrorCode ?? 'Unknown'} ${entry?.ErrorMessage ?? ''}`.trim()
    );
  }

  metrics.addMetric('DomainEventPublished', MetricUnit.Count, 1);
  logger.info('Published domain event', {
    detailType: outbox.detailType,
    eventId: outbox.eventId,
    aggregateId: outbox.aggregateId
  });
};

const lambdaHandler = async (event) => {
  const records = event.Records ?? [];

  for (const record of records) {
    try {
      await publishRecord(record);
    } catch (error) {
      // Ordered source: report the first failed sequence number and stop.
      // DynamoDB Streams re-delivers this record and everything after it, so we
      // must not publish any later record in this batch.
      const sequenceNumber = record.dynamodb?.SequenceNumber;
      logger.error('Failed to publish outbox record; halting batch to preserve order', { error, sequenceNumber });
      metrics.addMetric('DomainEventPublishFailed', MetricUnit.Count, 1);
      return { batchItemFailures: [{ itemIdentifier: sequenceNumber }] };
    }
  }

  return { batchItemFailures: [] };
};

// Block bodies matter: a value returned from a middy after/onError hook replaces
// the handler response, and publishStoredMetrics() returns the Metrics instance.
export const handler = middy(lambdaHandler)
  .use(injectLambdaContext(logger))
  .use({
    after: () => {
      metrics.publishStoredMetrics();
    },
    onError: () => {
      metrics.publishStoredMetrics();
    }
  });
