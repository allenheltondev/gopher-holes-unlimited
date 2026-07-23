import middy from '@middy/core';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { logger, metrics } from '../lib/powertools.js';
import { makeEventIdempotent } from '../lib/idempotency.js';
import { isConditionalCheckFailure } from '../lib/dynamo.js';
import { DetailType } from '../lib/events.js';
import { findHolesAtLocation, getHole, linkGopherToHole, syncLinkStatus } from '../lib/repository/holes.js';
import { findGophersAtLocation } from '../lib/repository/gophers.js';

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
    // Only a genuine condition failure means "already linked". A transient
    // transaction conflict/throttle must propagate so the event is retried,
    // otherwise the link (and its outbox event) would be silently lost.
    if (isConditionalCheckFailure(error)) return false;
    throw error;
  }
};

// Write a set of gopher/hole links concurrently. allSettled (not Promise.all) so
// every write finishes before we return — a fail-fast reject would let Lambda
// freeze the environment with sibling writes still in flight. Any genuine failure
// is re-thrown so the whole (idempotent) event is redelivered; links already
// written simply no-op next time. Retry belongs at the invocation boundary, not
// in a loop here that could burn Lambda duration and hit the timeout.
const linkAll = async (links) => {
  const outcomes = await Promise.allSettled(links.map(linkIfNotAlready));
  const linked = outcomes.filter((outcome) => outcome.status === 'fulfilled' && outcome.value).length;
  const failures = outcomes.filter((outcome) => outcome.status === 'rejected').map((outcome) => outcome.reason);
  metrics.addMetric('GopherHoleLinksCreated', MetricUnit.Count, linked);
  if (failures.length) {
    throw new AggregateError(failures, `Failed to write ${failures.length} of ${links.length} link(s)`);
  }
  return linked;
};

export const onGopherCreated = async ({ id, location }) => {
  const holesHere = await findHolesAtLocation(location);
  const linked = await linkAll(
    holesHere.map((hole) => ({ gopherId: id, holeId: hole.id, description: hole.description, status: hole.status }))
  );
  logger.info('Linked gopher to holes at its location', { gopherId: id, linked });
};

export const onHoleCreated = async ({ id, gopherId, description, status, location }) => {
  // Symmetric to onGopherCreated: link the digger (when named) plus every gopher
  // already seen at this location. Discovery uses the strongly-consistent
  // location rendezvous, so whichever of the gopher/hole committed first is
  // guaranteed to be visible to the other's reaction — a link can't be lost even
  // when the two are created at the same instant.
  const gopherIds = new Set((await findGophersAtLocation(location)).map((gopher) => gopher.id));
  if (gopherId) gopherIds.add(gopherId);
  const linked = await linkAll(
    [...gopherIds].map((linkedGopherId) => ({ gopherId: linkedGopherId, holeId: id, description, status }))
  );
  logger.info('Linked hole to gophers at its location', { holeId: id, linked });
};

export const onHoleStatusChanged = async ({ id }) => {
  // Re-read the hole (strongly consistent) and propagate its CURRENT status.
  // hole.status-changed events can arrive out of order (EventBridge delivery is
  // best-effort ordered), but the hole item is the single source of truth for its
  // latest status, so syncing links to it converges regardless of event order.
  const hole = await getHole(id, { consistentRead: true });
  if (!hole) return;
  const updated = await syncLinkStatus(id, hole.status);
  logger.info('Propagated hole status to links', { holeId: id, status: hole.status, updated });
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
