import middy from '@middy/core';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { BatchProcessor, EventType, processPartialResponse } from '@aws-lambda-powertools/batch';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { logger, metrics, tracer } from '../lib/powertools.js';

// The outbox relay is the "message relay" half of the transactional outbox
// pattern. DynamoDB Streams delivers newly-committed outbox records here, and we
// forward each one to EventBridge exactly as the domain intended. An event-source
// mapping filter (see template.yaml) ensures only outbox INSERTs reach this
// function, but we defend against anything else slipping through.
//
// BatchProcessor gives us partial-batch responses: if a single event fails to
// publish, only that record is retried instead of the whole batch.

const eventBridge = tracer.captureAWSv3Client(new EventBridgeClient({}));
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME;

const processor = new BatchProcessor(EventType.DynamoDBStreams);

const recordHandler = async (record) => {
  if (record.eventName !== 'INSERT') return;
  const image = record.dynamodb?.NewImage;
  if (!image) return;

  const outbox = unmarshall(image);
  if (outbox.entityType !== 'outbox') return;

  await eventBridge.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: EVENT_BUS_NAME,
          Source: outbox.source,
          DetailType: outbox.detailType,
          Detail: JSON.stringify({ eventId: outbox.eventId, ...outbox.detail })
        }
      ]
    })
  );

  metrics.addMetric('DomainEventPublished', MetricUnit.Count, 1);
  logger.info('Published domain event', { detailType: outbox.detailType, eventId: outbox.eventId });
};

export const handler = middy(async (event, context) =>
  processPartialResponse(event, recordHandler, processor, { context })
)
  .use(injectLambdaContext(logger))
  .use({
    after: () => metrics.publishStoredMetrics(),
    onError: () => metrics.publishStoredMetrics()
  });
