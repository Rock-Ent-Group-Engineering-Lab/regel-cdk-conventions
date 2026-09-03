import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwactions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

/**
 * Alarm shape for a Lambda-hosted MCP server (REG-634, decided 2026-09-03).
 *
 * Why this exists: the fleet's first shape was `Errors >= 1` in one
 * five-minute window with the alerts topic wired to BOTH alarm and OK
 * actions. On mcp-reg-itglue that produced ~130 notifications in eight
 * days for a single root cause (REG-620), and the relay filed 21
 * recurrence comments. An alarm that fires when nothing is wrong trains
 * everyone to ignore the channel.
 *
 * The shape:
 *  - errors:   Errors >= 1 in 2 of the last 3 five-minute windows. A single
 *              transient does not page; a sustained failure pages within ten
 *              minutes. Alarm action only.
 *  - stuck:    Duration p99 >= `stuckFraction` (default 0.8) of the function
 *              timeout, one window. The canary for a held-open response
 *              stream (an MCP listen/SSE stream on Lambda) or a hung backend.
 *              This is what would have said "stuck stream" on day one.
 *  - dlq:      DLQ depth >= 1 (when a DLQ is passed).
 *  - infra:    an optional application EMF metric for handled failures that
 *              never reach Lambda Errors (backend_error envelopes and the like).
 *
 * No alarm here adds an OK action. Recovery is visible in the console and in
 * the relay digest; a second notification per flip is only noise. The relay
 * (app-relay-hub) ignores plain OK transitions, so nothing downstream needs them.
 *
 * Construct ids default to the ids the fleet already used for the same alarms
 * (`ServerFnErrorsAlarm`, `ServerDlqDepthAlarm`, `InfraFailureAlarm`) so a
 * repo moving onto this helper updates its alarms in place instead of
 * replacing them (a replacement with the same AlarmName fails in
 * CloudFormation). Pass `ids` when a stack used different ones.
 */
export interface McpLambdaAlarmsProps {
  /** The MCP server function. */
  readonly fn: lambda.IFunction;
  /** The function's configured timeout; the stuck threshold derives from it. */
  readonly timeout: cdk.Duration;
  /** The shared alerts topic (regel-core-pipeline-alerts). */
  readonly alertsTopic: sns.ITopic;
  /** Alarm name prefix, e.g. `regel-core-mcp-itglue`. Names become
   *  `<prefix>-server-errors`, `<prefix>-server-stuck`, `<prefix>-dlq-not-empty`,
   *  `<prefix>-infra-failure`. */
  readonly alarmPrefix: string;
  /** Log group to point at in alarm descriptions. Defaults to /aws/lambda/<fn name>. */
  readonly logGroupName?: string;
  /** The function's DLQ, if it has one. */
  readonly dlq?: sqs.IQueue;
  /** Application metric for handled failures (EMF), alarmed at >= 1 per window. */
  readonly infraFailureMetric?: cloudwatch.IMetric;
  /** Extra text appended to the infra-failure description (what to check). */
  readonly infraFailureHint?: string;
  /** Fraction of the timeout at which p99 Duration counts as stuck. Default 0.8. */
  readonly stuckFraction?: number;
  /** Construct ids, for stacks whose existing alarms used other ids. */
  readonly ids?: {
    readonly errors?: string;
    readonly stuck?: string;
    readonly dlq?: string;
    readonly infraFailure?: string;
  };
}

export interface McpLambdaAlarms {
  readonly errors: cloudwatch.Alarm;
  readonly stuck: cloudwatch.Alarm;
  readonly dlq?: cloudwatch.Alarm;
  readonly infraFailure?: cloudwatch.Alarm;
}

const FIVE_MINUTES = cdk.Duration.minutes(5);

export function mcpLambdaAlarms(scope: Construct, props: McpLambdaAlarmsProps): McpLambdaAlarms {
  const ids = {
    errors: 'ServerFnErrorsAlarm',
    stuck: 'ServerFnStuckAlarm',
    dlq: 'ServerDlqDepthAlarm',
    infraFailure: 'InfraFailureAlarm',
    ...(props.ids ?? {}),
  };
  const action = new cwactions.SnsAction(props.alertsTopic);
  const logGroup = props.logGroupName ?? `/aws/lambda/${props.fn.functionName}`;
  const timeoutSeconds = props.timeout.toSeconds();
  const fraction = props.stuckFraction ?? 0.8;
  const stuckMs = Math.round(props.timeout.toMilliseconds() * fraction);

  const errors = new cloudwatch.Alarm(scope, ids.errors, {
    alarmName: `${props.alarmPrefix}-server-errors`,
    alarmDescription:
      `${props.alarmPrefix}: Lambda Errors in 2 of the last 3 five-minute windows ` +
      `(one transient window does not page). Check ${logGroup}. ` +
      `A ${timeoutSeconds}s REPORT with Status: timeout means a held-open stream, see the stuck alarm.`,
    metric: props.fn.metricErrors({ period: FIVE_MINUTES, statistic: 'Sum' }),
    threshold: 1,
    evaluationPeriods: 3,
    datapointsToAlarm: 2,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  errors.addAlarmAction(action);

  const stuck = new cloudwatch.Alarm(scope, ids.stuck, {
    alarmName: `${props.alarmPrefix}-server-stuck`,
    alarmDescription:
      `${props.alarmPrefix}: p99 Duration >= ${Math.round(fraction * 100)}% of the ` +
      `${timeoutSeconds}s function timeout. An invocation is being held open: an MCP ` +
      `listen/SSE stream (a Lambda cannot host one; REG-620, incident known-failures #9) ` +
      `or a hung backend. Check ${logGroup} for REPORT lines at the timeout.`,
    metric: props.fn.metricDuration({ period: FIVE_MINUTES, statistic: 'p99' }),
    threshold: stuckMs,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  stuck.addAlarmAction(action);

  let dlq: cloudwatch.Alarm | undefined;
  if (props.dlq) {
    dlq = new cloudwatch.Alarm(scope, ids.dlq, {
      alarmName: `${props.alarmPrefix}-dlq-not-empty`,
      alarmDescription:
        `${props.alarmPrefix}: the DLQ has >= 1 message, an invocation failed after retries. ` +
        `Inspect ${props.dlq.queueName}; messages are the replay set, never delete them.`,
      metric: props.dlq.metricApproximateNumberOfMessagesVisible({ period: FIVE_MINUTES, statistic: 'Maximum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    dlq.addAlarmAction(action);
  }

  let infraFailure: cloudwatch.Alarm | undefined;
  if (props.infraFailureMetric) {
    infraFailure = new cloudwatch.Alarm(scope, ids.infraFailure, {
      alarmName: `${props.alarmPrefix}-infra-failure`,
      alarmDescription:
        `${props.alarmPrefix}: a tool returned an infrastructure failure to a user ` +
        `(handled, so it never reaches Lambda Errors). Check the audit lines in ${logGroup}.` +
        (props.infraFailureHint ? ` ${props.infraFailureHint}` : ''),
      metric: props.infraFailureMetric,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    infraFailure.addAlarmAction(action);
  }

  return { errors, stuck, dlq, infraFailure };
}
