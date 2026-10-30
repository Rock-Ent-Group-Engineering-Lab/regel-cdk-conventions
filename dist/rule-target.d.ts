import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
/**
 * A Lambda behind an EventBridge rule, wired the REGEL way (fleet audit triage,
 * REG-1562, Oct 29-30 2026: about 30 repos were fixed by hand for the same gaps).
 *
 * One call attaches the function to the rule and adds everything that keeps a
 * failed run from vanishing:
 *
 *  - ruleDlq:     the rule target's dead-letter queue. EventBridge could not
 *                 invoke the function (throttled, permission, function missing).
 *                 SSE-SQS, TLS only, 14 days. CDK adds the queue policy that lets
 *                 events.amazonaws.com send, and only for THIS rule.
 *  - onFailureDlq: the function's async onFailure destination. A rule target's DLQ
 *                 never sees an error the handler throws: once Lambda accepts the
 *                 async invoke (202), a raised exception is retried twice and then
 *                 dropped unless the function has an onFailure destination. Same
 *                 queue settings.
 *  - a depth alarm on each queue (>= 1 visible message, one five-minute window)
 *    to the alerts topic. One window is deliberate: a message in a failure queue
 *    stays there, so the alarm fires on the first failure of a job that runs once
 *    a day or once a week. (An "Errors in 2 of 3 windows" shape never fires for a
 *    job that runs less often than every ten minutes.)
 *  - optionally a missed-run alarm (see `missedRunAfter`).
 *
 * Alarm actions only, no OK notifications, like mcpLambdaAlarms (REG-634).
 *
 * Gotchas this encodes, each found the hard way:
 *  - Queue names are literals. A queue named from `fn.functionName` (a Ref to the
 *    function) makes the queue depend on the function while the function's role
 *    policy that grants the send depends on the queue: CloudFormation rejects the
 *    cycle at deploy, not at synth (reg-uptop-pipeline, Oct 30). `name` must be
 *    a plain string; a token throws.
 *  - The queues carry SSE-SQS, never the shared data KMS key: its policy does not
 *    admit events.amazonaws.com, so EventBridge could not write to the DLQ and the
 *    safety net was inert (onelogin, perplexity, claude-pipeline).
 *  - The alerts topic must not be KMS-encrypted for the same reason: CloudWatch
 *    and EventBridge cannot publish to it, and every alarm action fails without a
 *    sound (136 failed actions in 30 days on the Ringside topic). A topic you pass
 *    that carries a `masterKey` throws.
 *
 * Covers Lambda targets on a rule in the same stack. ECS-task and SNS targets
 * keep their own `deadLetterQueue`; S3- and SNS-triggered functions set
 * `configureAsyncInvoke` themselves.
 *
 * For new code. Existing hand-written equivalents are deployed and verified; their
 * construct ids differ, and moving them onto this replaces the named queues and
 * alarms, which CloudFormation rejects because the names already exist.
 *
 * Do not also set `onFailure`, `retryAttempts` or `maxEventAge` in the function's
 * own props, or call `configureAsyncInvoke` on it: a function takes one event
 * invoke config, and CDK throws on the second.
 */
export interface RegelRuleTargetProps {
    /** The rule that invokes the function (a schedule or an event pattern). Must be
     *  in the same stack as `scope`. */
    readonly rule: events.Rule;
    /** The function to invoke. Must be in the same stack as `scope`. */
    readonly fn: lambda.IFunction;
    /** Base name for the queues and alarms, a LITERAL string: normally the same
     *  literal you gave the function's `functionName`, e.g. `regel-core-wit-sync`.
     *  Queues become `<name>-eb-dlq` and `<name>-onfailure-dlq`; alarms
     *  `<queue>-not-empty` and `<name>-missed-run`. Letters, digits, `-` and `_`,
     *  at most 66 characters. */
    readonly name: string;
    /** What the rule sends the function. Default: the event EventBridge matched. */
    readonly event?: events.RuleTargetInput;
    /** EventBridge delivery retries before an event goes to the rule DLQ. Default 2. */
    readonly retryAttempts?: number;
    /** How long EventBridge keeps retrying delivery. Default 2 hours. */
    readonly maxEventAge?: cdk.Duration;
    /** Lambda async-invoke retries after the handler raises (0 to 2). Default 2, Lambda's own
     *  default written down. A job that must not run twice (a long crawl) sets 0. */
    readonly asyncRetryAttempts?: number;
    /** How long Lambda keeps an async event before it goes to onFailure. Default 6
     *  hours, Lambda's own default. */
    readonly asyncMaxEventAge?: cdk.Duration;
    /** Where the alarms notify. Default: the shared `regel-core-pipeline-alerts`
     *  topic in this stack's account and region. Must not be KMS-encrypted. */
    readonly alertsTopic?: sns.ITopic;
    /** Alarm when the function has not been invoked for this long: the rule was
     *  disabled, EventBridge stopped delivering, or the schedule changed, none of
     *  which raises an error. Size it to the schedule plus grace: 26 hours for a
     *  daily rule, 3 hours for an hourly one. Whole minutes, at most 6 days (an
     *  Invocations alarm cannot look back further than 7, so a weekly rule needs a
     *  freshness metric instead). Skipped while the rule is disabled, because an
     *  alarm that is always red teaches people to ignore the topic. Expect one
     *  flip to ALARM right after the first deploy, until the first run. */
    readonly missedRunAfter?: cdk.Duration;
}
export interface RegelRuleTarget {
    /** Receives events EventBridge could not deliver to the function. */
    readonly ruleDlq: sqs.Queue;
    readonly ruleDlqAlarm: cloudwatch.Alarm;
    /** Receives async invocations that failed after their retries. */
    readonly onFailureDlq: sqs.Queue;
    readonly onFailureDlqAlarm: cloudwatch.Alarm;
    /** Present when `missedRunAfter` is set and the rule is enabled. */
    readonly missedRunAlarm?: cloudwatch.Alarm;
}
export declare function regelRuleTarget(scope: Construct, id: string, props: RegelRuleTargetProps): RegelRuleTarget;
