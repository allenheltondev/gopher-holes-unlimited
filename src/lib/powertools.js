import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';

// Shared Powertools singletons. Service name and namespace are picked up from
// the POWERTOOLS_SERVICE_NAME and POWERTOOLS_METRICS_NAMESPACE environment
// variables set on every function in the SAM template, so there is a single
// source of truth for how telemetry is tagged across the service.
export const logger = new Logger();
export const metrics = new Metrics();
export const tracer = new Tracer();
