import middy from '@middy/core';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { logger, metrics } from '../lib/powertools.js';
import { makeEventIdempotent } from '../lib/idempotency.js';
import { DetailType } from '../lib/events.js';
import { findHolesAtLocation, linkGopherToHole, syncLinkStatus } from '../lib/repository/holes.js';

// Choreography consumer: reacts to domain events on the event bus to carry out
// cross-aggregate side effects. This is where the old Step Function's
// "find holes at this location and link them" logic now lives — expressed as a
// plain event handler instead of an orchestration.
//
// Each reaction is itself a transactional-outbox write, so the events it emits
// (e.g. GopherHoleLinked) are published through the same relay. Because links are
// written with a `attribute_not_exists` condition, replays are naturally
// idempotent: re-processing an event simply no-ops on the already-linked pairs.

const alreadyLinked = (err) =>
  err?.name === 'TransactionCanceledException' ||
  err?.name === 'ConditionalCheckFailedException' ||
  err?.CancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed');

const onGopherCreated = async ({ id, location }) => {
  const nearbyHoles = await findHolesAtLocation(location);
  let linked = 0;
  for (const hole of nearbyHoles) {
    try {
      await linkGopherToHole({ gopherId: id, holeId: hole.id, description: hole.description, status: hole.status });
      linked += 1;
    } catch (err) {
      if (!alreadyLinked(err)) throw err;
    }
  }
  logger.info('Linked gopher to holes at its location', { gopherId: id, linked });
  metrics.addMetric('HolesLinkedToGopher', MetricUnit.Count, linked);
};

const onHoleCreated = async ({ id, gopherId, description, status }) => {
  if (!gopherId) return;
  try {
    await linkGopherToHole({ gopherId, holeId: id, description, status });
    metrics.addMetric('HolesLinkedToGopher', MetricUnit.Count, 1);
  } catch (err) {
    if (!alreadyLinked(err)) throw err;
  }
};

const onHoleStatusChanged = async ({ id, status }) => {
  const updated = await syncLinkStatus(id, status);
  logger.info('Propagated hole status to links', { holeId: id, status, updated });
};

const routes = {
  [DetailType.GopherCreated]: onGopherCreated,
  [DetailType.HoleCreated]: onHoleCreated,
  [DetailType.HoleStatusChanged]: onHoleStatusChanged
};

// Processing is wrapped in consumer-side idempotency keyed on `detail.eventId`,
// so a re-delivered event is recognised and skipped rather than re-applied.
// The reactions below are also written to be idempotent on their own (links use
// `attribute_not_exists` conditions; status sync is a set-to-value), giving
// defense in depth against the at-least-once event stream.
const processEvent = makeEventIdempotent(async (event) => {
  const detailType = event['detail-type'];
  const route = routes[detailType];
  if (!route) {
    logger.debug('No choreography handler registered for event', { detailType });
    return;
  }
  await route(event.detail);
});

const lambdaHandler = async (event) => {
  logger.appendKeys({ detailType: event['detail-type'], eventId: event.detail?.eventId });
  await processEvent(event);
};

export const handler = middy(lambdaHandler)
  .use(injectLambdaContext(logger, { clearState: true }))
  .use({
    after: () => {
      metrics.publishStoredMetrics();
    },
    onError: () => {
      metrics.publishStoredMetrics();
    }
  });
