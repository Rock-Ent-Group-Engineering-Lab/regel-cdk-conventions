import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
/**
 * A scheduled job on EventBridge Scheduler, wired the REGEL way (REG-1610, Oct 30 2026).
 *
 * New scheduled jobs use Scheduler, not an EventBridge rule with a cron expression:
 *
 *  - Eastern time. A rule's cron is UTC only, so a 7:15 AM Eastern send drifts an hour twice a
 *    year (and a fixed-UTC send is wrong half the year). A schedule takes a time zone and follows
 *    daylight saving time itself. The default here is America/New_York.
 *  - Retry and a dead-letter queue are part of the schedule (`retryPolicy`, `deadLetterConfig`),
 *    not a target option you have to remember. Scheduler's own defaults are 185 attempts over 24
 *    hours; this helper sets 2 attempts over 2 hours like regelRuleTarget.
 *
 * Keep `regelRuleTarget` for event-pattern rules (a Scheduler schedule only fires on a clock).
 *
 * One call creates the schedule and everything that keeps a failed run from vanishing:
 *
 *  - the schedule: flexible window OFF (it fires on the minute, not within a window), the
 *    expression and time zone, the retry policy, and the DLQ.
 *  - an execution role Scheduler assumes: trust limited to the Scheduler service in this account
 *    (`aws:SourceAccount`) and the default schedule group (`aws:SourceArn`), permissions limited to
 *    invoking THIS target and sending to THIS schedule's DLQ. Nothing else.
 *  - `<name>-schedule-dlq`: Scheduler could not deliver (throttled, permission, function missing,
 *    RunTask refused). SSE-SQS, TLS only, 14 days, a literal name, with a depth alarm (>= 1,
 *    one five-minute window) to the shared alerts topic. Alarm actions only, no OK notifications.
 *  - Lambda targets also get `<name>-onfailure-dlq`: Scheduler invokes a function ASYNCHRONOUSLY,
 *    so once Lambda accepts the invoke (202) a handler that raises is retried twice and then
 *    dropped unless the function has an onFailure destination. Same queue settings, same alarm.
 *    This is the same gap regelRuleTarget closes, and the fleet check flags a function that is
 *    invoked asynchronously without it. A function takes ONE async invoke config: when a second
 *    schedule targets the same function (or you wired onFailure by hand), pass `onFailure: false`.
 *  - optionally a missed-run alarm for a Lambda target (`missedRunAfter`, see the prop).
 *
 * What the target receives: exactly `input` (an empty event if you pass none). It is NOT an
 * EventBridge rule event, so a handler that reads `event["detail-type"]` or `event["source"]`
 * needs a change; send `input: { source: 'schedule' }` if it dispatches on that.
 *
 * ECS (Fargate) targets: Scheduler's templated ECS target cannot carry container overrides, and
 * REGEL jobs pick their command and environment that way, so an ECS target uses the universal
 * `aws-sdk:ecs:runTask` target and `task.containerOverrides` becomes RunTask's overrides. A
 * RunTask call that ECS refuses lands in the DLQ; a task that starts and then exits non-zero is
 * still the job of the ECS task-state rule (see invariants.md), and there is no missed-run alarm
 * for ECS (Scheduler publishes metrics per schedule group, not per schedule).
 *
 * Gotchas this encodes:
 *  - Queue names are literals, as in regelRuleTarget: a name built from `fn.functionName` makes the
 *    queue depend on the function while the function's role policy depends on the queue, a cycle
 *    CloudFormation rejects at deploy, not at synth. `name` must be a plain string; a token throws.
 *  - The queues carry SSE-SQS, never the shared data KMS key (its policy does not admit the event
 *    services), and the alerts topic must not be KMS-encrypted (CloudWatch could not publish to it).
 *  - The `aws:SourceArn` in the trust policy has to be a schedule GROUP, never a schedule or a name
 *    prefix: Scheduler documents it that way, so the role is scoped to the default group.
 *  - A schedule cannot be tagged (only a schedule group can), so the repo tags on it come from the
 *    stack tags on the role, function and queues, which is how the fleet check finds its repo.
 *
 * For new code. The schedule lives in the default schedule group.
 *
 * Moving a job from regelRuleTarget: use the same `id` and `name`. The onFailure queue and the
 * missed-run alarm keep their logical ids and stay as they are; the rule and its `-eb-dlq` go
 * away and the schedule and its `-schedule-dlq` arrive. Remove the rule and the regelRuleTarget
 * call in the same change.
 */
export interface RegelScheduleContainerOverride {
    /** The container name in the task definition. */
    readonly name: string;
    /** Replaces the container's command. */
    readonly command?: string[];
    /** Environment variables to set on this run. RunTask merges them over the task definition's by name. */
    readonly environment?: Record<string, string>;
}
export interface RegelScheduleEcsTask {
    /** The cluster to run on. Must be in the same stack as `scope`. */
    readonly cluster: ecs.ICluster;
    /** A Fargate task definition. Must be in the same stack as `scope`. Its task and execution roles are
     *  passed to ECS by the execution role (iam:PassRole), and only those. */
    readonly taskDefinition: ecs.TaskDefinition;
    /** Security groups for the task's network interface. */
    readonly securityGroups?: ec2.ISecurityGroup[];
    /** Subnets, picked from the cluster's VPC. Default: private subnets with egress. */
    readonly vpcSubnets?: ec2.SubnetSelection;
    /** Give the task a public IP. Default: only when the subnets are public. */
    readonly assignPublicIp?: boolean;
    /** Container overrides for each run (command, environment). */
    readonly containerOverrides?: RegelScheduleContainerOverride[];
}
export interface RegelScheduleProps {
    /** The schedule's name and the base for the queue and alarm names, a LITERAL string: letters, digits,
     *  `-` and `_`, at most 64 characters (a schedule name's limit; `<name>-onfailure-dlq` has to fit
     *  SQS's 80 too). Queues become `<name>-schedule-dlq` and `<name>-onfailure-dlq`; alarms
     *  `<queue>-not-empty` and `<name>-missed-run`. Normally the function's literal `functionName`
     *  for a job with one schedule, or `<function>-<when>` when a function has several. */
    readonly name: string;
    /** `cron(minute hour day-of-month month day-of-week year)` or `rate(5 minutes)`. One of day-of-month
     *  and day-of-week must be `?`. In the time zone below; a `rate` ignores the time zone. */
    readonly schedule: string;
    /** IANA time zone for a cron expression. Default `America/New_York`: 7:15 means 7:15 Eastern all year. */
    readonly timeZone?: string;
    /** The schedule's description (at most 512 characters). Default: the name. */
    readonly description?: string;
    /** A Lambda target. Give this or `task`. Must be in the same stack as `scope`. */
    readonly fn?: lambda.IFunction;
    /** An ECS Fargate task target. Give this or `fn`. */
    readonly task?: RegelScheduleEcsTask;
    /** What a Lambda target receives, as an object. Default: an empty event. (For an ECS target the run's
     *  inputs are `task.containerOverrides`.) */
    readonly input?: Record<string, unknown>;
    /** Default true. A disabled schedule is created but does not fire. */
    readonly enabled?: boolean;
    /** Scheduler delivery retries before an event goes to the DLQ (0 to 185). Default 2. */
    readonly retryAttempts?: number;
    /** How long Scheduler keeps retrying delivery (1 minute to 24 hours). Default 2 hours. */
    readonly maxEventAge?: cdk.Duration;
    /** Lambda targets: attach the function's async `onFailure` queue. Default true. Pass false when the
     *  function already has an async invoke config (a second schedule on the same function, or one wired by
     *  hand), because a function takes only one. */
    readonly onFailure?: boolean;
    /** Async invoke retries after the handler raises (0 to 2). Default 2, Lambda's own default written down.
     *  A job that must not run twice (a long crawl) sets 0. */
    readonly asyncRetryAttempts?: number;
    /** How long Lambda keeps an async event before it goes to onFailure. Default 6 hours. */
    readonly asyncMaxEventAge?: cdk.Duration;
    /** Where the alarms notify. Default: the shared `regel-core-pipeline-alerts` topic in this stack's account
     *  and region. Must not be KMS-encrypted. */
    readonly alertsTopic?: sns.ITopic;
    /** Lambda targets: alarm when the function has not been invoked for this long (the schedule was disabled
     *  or changed, or Scheduler stopped delivering, none of which raises an error). Size it to the schedule
     *  plus grace: 26 hours for a daily schedule. Whole minutes, at most 6 days. Skipped while the schedule is
     *  disabled. Counts every invocation of the function, so on a function with several schedules it only
     *  catches all of them going quiet. Expect one flip to ALARM right after the first deploy, until the first
     *  run. Not available for ECS targets. */
    readonly missedRunAfter?: cdk.Duration;
}
export interface RegelSchedule {
    readonly schedule: scheduler.CfnSchedule;
    /** The role Scheduler assumes. */
    readonly role: iam.Role;
    /** Receives events Scheduler could not deliver to the target. */
    readonly dlq: sqs.Queue;
    readonly dlqAlarm: cloudwatch.Alarm;
    /** Present for a Lambda target unless `onFailure: false`. Receives async invocations that failed. */
    readonly onFailureDlq?: sqs.Queue;
    readonly onFailureDlqAlarm?: cloudwatch.Alarm;
    /** Present when `missedRunAfter` is set and the schedule is enabled. */
    readonly missedRunAlarm?: cloudwatch.Alarm;
}
export declare function regelSchedule(scope: Construct, id: string, props: RegelScheduleProps): RegelSchedule;
