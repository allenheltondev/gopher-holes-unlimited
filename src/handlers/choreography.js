import middy from '@middy/core';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { logger, metrics } from '../lib/powertools.js';
import { makeEventIdempotent } from '../lib/idempotency.js';
import { isConditionalCheckFailure } from '../lib/dynamo.js';
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

// Links are written with an `attribute_not_exists` condition, so a re-processed
// event just fails that condition on the pairs already linked. Swallow only that
// case; anything else is a real error and should fail so the event is retried.
const linkIfNotAlready = async (link) => {
  try {
    await linkGopherToHole(link);
    return true;
  } catch (error) {
    if (isConditionalCheckFailure(error)) return false;
    throw error;
  }
};

export const onGopherCreated = async ({ id, location }) => {
  const nearbyHoles = await findHolesAtLocation(location);

  // allSettled, not Promise.all: we want every link write to finish before this
  // handler returns. A fail-fast reject would let Lambda freeze the environment
  // with sibling writes still in flight. Already-linked pairs resolve to false.
  const outcomes = await Promise.allSettled(
    nearbyHoles.map((hole) =>
      linkIfNotAlready({ gopherId: id, holeId: hole.id, description: hole.description, status: hole.status })
    )
  );

  const linked = outcomes.filter((outcome) => outcome.status === 'fulfilled' && outcome.value).length;
  const failures = outcomes.filter((outcome) => outcome.status === 'rejected').map((outcome) => outcome.reason);
  metrics.addMetric('HolesLinkedToGopher', MetricUnit.Count, linked);
  logger.info('Linked gopher to holes at its location', { gopherId: id, linked, failed: failures.length });

  // Retrying failures is the invocation's job, not a loop in here: throwing fails
  // the event so EventBridge/Lambda re-delivers it, and the links already written
  // simply no-op on the next pass (they are idempotent). This avoids burning
  // Lambda duration on an in-handler retry loop that could hit the timeout.
  if (failures.length) {
    throw new AggregateError(failures, `Failed to link ${failures.length} of ${nearbyHoles.length} hole(s)`);
  }
};

const onHoleCreated = async ({ id, gopherId, description, status }) => {
  if (!gopherId) return;
  const linked = await linkIfNotAlready({ gopherId, holeId: id, description, status });
  if (linked) metrics.addMetric('HolesLinkedToGopher', MetricUnit.Count, 1);
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
