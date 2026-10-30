import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwactions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
export declare const ALERTS_TOPIC_NAME = "regel-core-pipeline-alerts";
export declare const FIVE_MINUTES: cdk.Duration;
/** A name that becomes part of queue and alarm names: a literal string, never a token. `max` is the longest
 *  name the longest derived name can carry; `why` says which derived name sets the limit. */
export declare function checkLiteralName(helper: string, id: string, name: string, max: number, why: string): void;
/** The alarm action for the alerts topic (default: the shared `regel-core-pipeline-alerts` in this stack's
 *  account and region). A KMS-encrypted topic throws: CloudWatch and EventBridge cannot publish to it. */
export declare function alertAction(helper: string, scope: Construct, id: string, topic?: sns.ITopic): cwactions.SnsAction;
/** A failure queue: SSE-SQS (never the shared data key, whose policy does not admit the event services),
 *  TLS only, 14 days, a literal name. */
export declare function failureQueue(scope: Construct, queueId: string, queueName: string): sqs.Queue;
/** >= 1 visible message in one five-minute window, alarm action only. One window on purpose: a message in a
 *  failure queue stays there, so it fires on the first failure of a daily or weekly job. */
export declare function depthAlarm(scope: Construct, alarmId: string, queue: sqs.Queue, queueName: string, description: string, alert: cwactions.SnsAction): cloudwatch.Alarm;
/** `missedRunAfter` is whole minutes, 1 minute to 6 days (an Invocations alarm cannot look back 7 days). */
export declare function checkMissedRunWindow(helper: string, id: string, window: cdk.Duration | undefined, what: string): void;
/** `Invocations < 1` over the window, missing data breaches, alarm action only. */
export declare function missedRunAlarm(scope: Construct, alarmId: string, name: string, fn: lambda.IFunction, window: cdk.Duration, description: string, alert: cwactions.SnsAction): cloudwatch.Alarm;
