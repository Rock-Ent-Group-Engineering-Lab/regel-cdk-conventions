// Pieces shared by regelRuleTarget (rule-target.ts) and regelSchedule (schedule.ts): the failure
// queue, its depth alarm, the alerts topic guard, the literal-name guard and the missed-run window.
// Internal: not exported from the package index, so the public surface stays small.
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwactions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export const ALERTS_TOPIC_NAME = 'regel-core-pipeline-alerts';
export const FIVE_MINUTES = cdk.Duration.minutes(5);
const MAX_MISSED_RUN_SECONDS = 6 * 24 * 60 * 60;

/** A name that becomes part of queue and alarm names: a literal string, never a token. `max` is the longest
 *  name the longest derived name can carry; `why` says which derived name sets the limit. */
export function checkLiteralName(helper: string, id: string, name: string, max: number, why: string): void {
  if (cdk.Token.isUnresolved(name)) {
    throw new Error(
      `${helper}(${id}): name must be a literal string, not a token. A queue named from ` +
      '`fn.functionName` makes the queue depend on the function and the function\'s role policy ' +
      'depend on the queue, a cycle CloudFormation rejects at deploy. Pass the same literal you ' +
      'gave the function\'s functionName.',
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(name) || name.length > max) {
    throw new Error(
      `${helper}(${id}): name "${name}" must be letters, digits, "-" or "_", at most ` +
      `${max} characters (${why}).`,
    );
  }
}

/** The alarm action for the alerts topic (default: the shared `regel-core-pipeline-alerts` in this stack's
 *  account and region). A KMS-encrypted topic throws: CloudWatch and EventBridge cannot publish to it. */
export function alertAction(helper: string, scope: Construct, id: string, topic?: sns.ITopic): cwactions.SnsAction {
  const stack = cdk.Stack.of(scope);
  const alertsTopic = topic ?? sns.Topic.fromTopicArn(
    scope, `${id}AlertsTopic`,
    `arn:aws:sns:${stack.region}:${stack.account}:${ALERTS_TOPIC_NAME}`,
  );
  if (alertsTopic.masterKey) {
    throw new Error(
      `${helper}(${id}): the alerts topic is KMS-encrypted. CloudWatch and EventBridge cannot ` +
      `publish to a topic whose key policy does not admit them, so every alarm action fails without ` +
      `a sound. Use ${ALERTS_TOPIC_NAME} or an unencrypted topic (alert messages carry no customer data).`,
    );
  }
  return new cwactions.SnsAction(alertsTopic);
}

/** A failure queue: SSE-SQS (never the shared data key, whose policy does not admit the event services),
 *  TLS only, 14 days, a literal name. */
export function failureQueue(scope: Construct, queueId: string, queueName: string): sqs.Queue {
  return new sqs.Queue(scope, queueId, {
    queueName,
    retentionPeriod: cdk.Duration.days(14),
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
  });
}

/** >= 1 visible message in one five-minute window, alarm action only. One window on purpose: a message in a
 *  failure queue stays there, so it fires on the first failure of a daily or weekly job. */
export function depthAlarm(
  scope: Construct, alarmId: string, queue: sqs.Queue, queueName: string, description: string, alert: cwactions.SnsAction,
): cloudwatch.Alarm {
  const alarm = new cloudwatch.Alarm(scope, alarmId, {
    alarmName: `${queueName}-not-empty`,
    alarmDescription: description,
    metric: queue.metricApproximateNumberOfMessagesVisible({ period: FIVE_MINUTES, statistic: 'Maximum' }),
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  alarm.addAlarmAction(alert);
  return alarm;
}

/** `missedRunAfter` is whole minutes, 1 minute to 6 days (an Invocations alarm cannot look back 7 days). */
export function checkMissedRunWindow(helper: string, id: string, window: cdk.Duration | undefined, what: string): void {
  if (!window) return;
  const seconds = window.toSeconds();
  if (seconds < 60 || seconds % 60 !== 0 || seconds > MAX_MISSED_RUN_SECONDS) {
    throw new Error(
      `${helper}(${id}): missedRunAfter must be whole minutes between 1 minute and 6 days ` +
      `(an Invocations alarm cannot look back 7 days, so a weekly ${what} needs a freshness metric).`,
    );
  }
}

/** `Invocations < 1` over the window, missing data breaches, alarm action only. */
export function missedRunAlarm(
  scope: Construct, alarmId: string, name: string, fn: lambda.IFunction, window: cdk.Duration,
  description: string, alert: cwactions.SnsAction,
): cloudwatch.Alarm {
  const alarm = new cloudwatch.Alarm(scope, alarmId, {
    alarmName: `${name}-missed-run`,
    alarmDescription: description,
    metric: fn.metricInvocations({ period: window, statistic: 'Sum' }),
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.BREACHING,
  });
  alarm.addAlarmAction(alert);
  return alarm;
}
