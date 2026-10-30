# regel-cdk-conventions

Shared CDK conventions package. Consumed as a git-dep by every REGEL CDK repo that deploys to account 859287179937.

## What this package owns

- `REGEL_CORE_ACCOUNT` / `REGEL_CORE_REGION` / `REGEL_CORE_ENV` — account + region constants
- `REGEL_CORE_BOUNDARY_ARN` — the permissions boundary ARN that must be on every IAM role (keeps the name `ClawBoundary`; that's the agent-identity policy and stays)
- `applyRegelCoreTags(scope, props)` — tags a stack + installs the boundary Aspect in one call
- `regelCoreSynthesizer()` — `CliCredentialsStackSynthesizer`. **The only synthesizer you should use.** REGEL does not bootstrap CDK in the regel-core account; `ClawBoundary` + org-level SCPs make bootstrap actively broken. Docker image assets work under this synthesizer — bootstrap is not required.
- `regelCoreBootstrapSynthesizer({ qualifier })` — **@deprecated.** Historical escape hatch for `reg-fanreach-pipeline` during Phase 4. Emits a console warning on call. Do not reach for this. If you think a new stack needs it, it doesn't.
- `RegelAppInferenceProfile` — wraps an AWS-managed cross-region inference profile (e.g. `us.anthropic.claude-sonnet-4-6`) as an Application Inference Profile so Bedrock invocations carry the stack's cost-allocation tags. Publishes the AIP ARN to `/regel-core/<appSlug>/bedrock-aip/<modelShortName>` so the runtime reads from SSM instead of hardcoding `us.anthropic.*`.
- `bedrockInvokeResources(aips)` — companion helper that returns the IAM resource ARNs you need to grant `bedrock:InvokeModel` on (the AIP ARN, the underlying system inference-profile ARN, and the foundation-model wildcard).
- `REGEL_BEDROCK_MODELS` — the canonical model-ID enum used for AIP `modelId`. Add new entries here when REGEL adopts a new model.
- `mcpLambdaAlarms(scope, props)` — the alarm shape for a Lambda-hosted MCP server (REG-634): Errors in 2 of 3 five-minute windows, a `Duration p99 >= 80% of timeout` stuck-stream canary, optional DLQ and EMF infra-failure alarms, alarm actions only (no OK notifications). Default construct ids match the fleet's original alarms so adoption is an in-place update. Every `mcp-reg-*` stack uses it; `create-regel-repo`'s MCP template emits it.
- `regelSchedule(scope, id, props)` — **a scheduled job (REG-1610): a Lambda or an ECS Fargate task on EventBridge Scheduler.** One call creates the schedule (flexible window off, a cron or rate expression, a time zone that defaults to `America/New_York`), the execution role (trust limited to Scheduler in this account and the default schedule group; permissions limited to invoking the target and sending to its DLQ), a DLQ (SSE-SQS, literal name, TLS only, 14 days) with a depth alarm (>= 1) to `regel-core-pipeline-alerts`, a retry policy (2 attempts, 2 hours), and for a Lambda the function's `onFailure` queue and alarm plus an optional missed-run alarm. Every new scheduled job uses it: a schedule runs on Eastern time all year and carries its own retry and DLQ, where a rule's cron is UTC only. Usage and gotchas: [Schedules](#schedules-regelschedule) below.
- `regelRuleTarget(scope, id, props)` — a Lambda on an EventBridge **event-pattern** rule, wired the REGEL way (fleet audit triage, REG-1562). One call attaches the function to your rule and adds the failure handling every rule target needs: a DLQ for the rule target (SSE-SQS, literal name, send policy pinned to that rule), an `onFailure` SQS destination on the function (a rule DLQ never sees an error the handler throws), a depth alarm (>= 1) on each queue, and an optional missed-run alarm sized to the schedule, all notifying `regel-core-pipeline-alerts` (alarm actions only). Lambda targets only; ECS and SNS targets keep their own `deadLetterQueue`. Use it for every new Lambda on an event-pattern rule; deployed hand-written equivalents are left alone. Gotchas and usage: [Rule targets](#rule-targets-regelruletarget) below.
- Deprecated aliases (`CLAW_BOUNDARY_ARN`, `applyClawTags`, `ClawTagProps`) for the Claw → regel-core rename overlap period. Dropped in v2.

## AWS profile

Always `regel-admin` (account 859287179937, us-east-2). The synthesizer uses caller credentials — if you run `cdk deploy` without `AWS_PROFILE=regel-admin`, you will either target the wrong account or fail outright.

## Releasing

1. Bump `package.json` `version`.
2. `npm run build` — commits the generated `dist/` (consumers use `main: dist/index.js` and don't run TypeScript). Git-dep consumers won't fetch dev dependencies or run `prepare`.
3. Commit both `src/` changes and the rebuilt `dist/`.
4. Tag: `git tag v1.x.y && git push --tags`.
5. Update consuming repos' `package.json` to the new tag when they're ready to pick it up. Never force-upgrade — each consumer cuts over on its own schedule.

**The `dist/` folder is committed intentionally.** Without it, every consumer would need a build step in CI and dev. Do not gitignore it.

## Versioning strategy

- **v1.x** — keeps legacy `applyClawTags` + `CLAW_BOUNDARY_ARN` aliases with `Account=claw` tag default. Adopted by all 14 pipeline repos during Phase 0a as a no-op refactor.
- **v2.0** — drops deprecated aliases, default `Account` tag becomes `regel-core`. Each repo upgrades to v2 during its Phase 4 per-repo cutover, alongside stack rename.

Don't ship v2 until at least one foundation stack has migrated and validated the new tag value in production.

## Consumer setup gotcha (TypeScript)

Every consuming repo's `infra/package.json` needs both `@types/node` *and* `ts-node` as devDependencies, and `tsconfig.json` must include `"types": ["node"]` inside `compilerOptions` — otherwise `ts-node` can't resolve `path` / `__dirname` and CDK fails with a confusing `TS2591: Cannot find name 'path'`. Also: deploy via `npm run deploy` or `./node_modules/.bin/cdk` (not `npx cdk` — that pulls a fresh npx cache that can't see local types).

## Bedrock cost attribution (mandatory)

Every REGEL stack that invokes Bedrock at runtime **must** provision one `RegelAppInferenceProfile` per (app, model) and have the runtime call Bedrock with the resulting **AIP ARN** as `modelId` — never the raw `us.anthropic.*` / `global.anthropic.*` system profile ID, never a foundation-model ARN.

**Why:** raw model IDs collapse all REGEL Bedrock spend into one Cost Explorer line. Application Inference Profiles propagate the parent stack's six standard tags onto every invocation, so Cost Explorer can group Bedrock cost by `Project` / `Owner` / `CostCenter` exactly like Lambda / Fargate / S3.

**Pattern:**

```ts
import {
  RegelAppInferenceProfile,
  REGEL_BEDROCK_MODELS,
  bedrockInvokeResources,
  applyRegelCoreTags,
} from 'regel-cdk-conventions';

applyRegelCoreTags(this, { project: 'quarry', environment: 'production', owner: 'conor' });

const sonnet = new RegelAppInferenceProfile(this, 'QuarrySonnet', {
  appSlug: 'quarry',
  modelId: REGEL_BEDROCK_MODELS.CLAUDE_SONNET_4_6,
});
const haiku = new RegelAppInferenceProfile(this, 'QuarryHaiku', {
  appSlug: 'quarry',
  modelId: REGEL_BEDROCK_MODELS.CLAUDE_HAIKU_4_5,
});

runtimeRole.addToPrincipalPolicy(new iam.PolicyStatement({
  actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
  resources: bedrockInvokeResources([sonnet, haiku]),
}));
```

The runtime reads each ARN from SSM at startup:

```python
import boto3, os
ssm = boto3.client('ssm')
SONNET_ARN = ssm.get_parameter(Name='/regel-core/quarry/bedrock-aip/claude-sonnet-4-6')['Parameter']['Value']
bedrock.converse(modelId=SONNET_ARN, ...)
```

For Mac-mini-hosted apps without a Lambda role (`app-penny`), grant `ssm:GetParameter` on the parameter and `bedrock:InvokeModel` on the resources from `bedrockInvokeResources(...)` to the IAM user that the daemon assumes.

When you add a new model to REGEL, add the system inference-profile ID to `REGEL_BEDROCK_MODELS` in this package — don't string-literal it elsewhere.

Titan Text Embeddings V2 has no system profile, so `REGEL_BEDROCK_MODELS.TITAN_EMBED_V2` copies from the regional foundation model; `bedrockInvokeResources` grants the AIP and that one foundation-model ARN. Call `invoke_model` with the AIP ARN as `modelId`, same as for Claude (verified: the embedding comes back and the invocation log shows the AIP ARN).

## Rule targets (`regelRuleTarget`)

Every new Lambda on an EventBridge event-pattern rule goes through `regelRuleTarget`, in `src/rule-target.ts` (the header comment there has the reasoning). A job on a clock uses [`regelSchedule`](#schedules-regelschedule).

```ts
import * as events from 'aws-cdk-lib/aws-events';
import { regelRuleTarget } from 'regel-cdk-conventions';

const rule = new events.Rule(this, 'OnUpload', {
  eventPattern: { source: ['aws.s3'], detailType: ['Object Created'] },
});
regelRuleTarget(this, 'Loader', {
  rule,
  fn: loaderFn,                            // created with functionName: 'regel-core-wit-loader'
  name: 'regel-core-wit-loader',           // the same literal, never fn.functionName
});
```

What it creates, all to `regel-core-pipeline-alerts` (alarm actions only):

- `<name>-eb-dlq`: EventBridge could not deliver (throttled, permission, function missing). Its queue policy admits `events.amazonaws.com` for this rule only.
- `<name>-onfailure-dlq`: the function's `onFailure` destination. The handler raised and Lambda's retries are used up; the record holds the event and the error. A rule DLQ never sees these, so the handler must also raise on failure (EventBridge discards return values).
- A depth alarm (`<queue>-not-empty`, >= 1 in one five-minute window) on each queue. One window on purpose: a message stays in the queue, so it fires on the first failure of a daily or weekly job.
- Optional `<name>-missed-run`: `Invocations < 1` over `missedRunAfter`, for a rule that stops firing without any error. At most 6 days; skipped while the rule is disabled; flips to ALARM once after the first deploy until the first run.

Defaults match what the hand-written fixes ran with: rule target 2 retries and 2 hours (`retryAttempts`, `maxEventAge`); function async invoke 2 retries and 6 hours (`asyncRetryAttempts`, `asyncMaxEventAge`; set `0` for a job that must not run twice). `event` passes a `RuleTargetInput`; `alertsTopic` replaces the shared topic.

It throws on the three mistakes that went silent in the fleet:

- A `name` built from `fn.functionName`. Queue names must be literals: a queue named from the function makes the queue depend on the function while the function's role policy depends on the queue, a cycle CloudFormation rejects at deploy, not at synth.
- An `alertsTopic` with a KMS key. CloudWatch and EventBridge cannot publish to a topic whose key policy does not admit them, and every alarm action fails without a sound. The queues are SSE-SQS for the same reason: the shared data key's policy does not admit `events.amazonaws.com`.
- A rule, function and scope in different stacks.

Also: do not set `onFailure`, `retryAttempts` or `maxEventAge` in the function's own props or call `configureAsyncInvoke` on it (one event invoke config per function). It adds no Errors alarm: for a job that runs less often than every ten minutes add a one-window `fn.metricErrors` alarm, because `mcpLambdaAlarms`'s 2-of-3 shape never fires for those.

## Schedules (`regelSchedule`)

Every new scheduled job (a Lambda or an ECS Fargate task that runs on a clock) goes through `regelSchedule`, in `src/schedule.ts` (the header comment there has the reasoning). Why Scheduler: a schedule takes a time zone, so 7:15 AM Eastern stays 7:15 AM Eastern through daylight saving time, and the retry policy and DLQ belong to the schedule itself.

```ts
import { regelSchedule } from 'regel-cdk-conventions';

regelSchedule(this, 'Briefing', {
  fn: briefingFn,                          // created with functionName: 'regel-core-sms-briefing'
  name: 'regel-core-sms-briefing',         // the schedule's name and the queue/alarm base: a literal, never fn.functionName
  schedule: 'cron(15 7 ? * MON-FRI *)',    // 7:15 AM Eastern on weekdays; the time zone defaults to America/New_York
  input: { source: 'schedule' },           // what the handler receives; omit for an empty event
  missedRunAfter: cdk.Duration.hours(26),  // a daily schedule plus 2 hours of grace; omit to skip
});

regelSchedule(this, 'Sync', {              // an ECS Fargate task
  name: 'regel-core-ceridian-sync',
  schedule: 'rate(1 hour)',
  task: {
    cluster, taskDefinition, securityGroups: [runSg],
    vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }, assignPublicIp: true,
    containerOverrides: [{ name: 'sync', command: ['python', 'ceridian.py'], environment: { CERIDIAN_SECRET_PREFIX: 'regel-core-ceridian-sync' } }],
  },
});
```

What it creates, all to `regel-core-pipeline-alerts` (alarm actions only):

- The schedule `<name>`, in the default group: flexible window off, `ENABLED` unless `enabled: false`, the time zone on a cron expression (a `rate` has none), retry policy (`retryAttempts` 2, `maxEventAge` 2 hours; Scheduler's own default is 185 attempts over 24 hours), and the DLQ.
- An execution role Scheduler assumes: trust is `scheduler.amazonaws.com` with `aws:SourceAccount` and `aws:SourceArn` set to the default schedule group (Scheduler wants a group ARN there, never a schedule); permissions are `lambda:InvokeFunction` on the function (or `ecs:RunTask` on the task definition and `iam:PassRole` for its roles) and `sqs:SendMessage` on the DLQ.
- `<name>-schedule-dlq`: Scheduler could not deliver (throttled, permission, function missing, ECS refused RunTask). Its depth alarm `<queue>-not-empty` fires at >= 1 in one five-minute window.
- For a Lambda, `<name>-onfailure-dlq` and its alarm: Scheduler invokes a function asynchronously, so a handler that raises is retried twice and then dropped unless the function has an `onFailure` destination. The handler must raise on failure. A function takes one async invoke config: for a second schedule on the same function (or one wired by hand) pass `onFailure: false`, and the helper says so if you forget.
- Optional `<name>-missed-run` (Lambda only): `Invocations < 1` over `missedRunAfter`, at most 6 days, skipped while the schedule is disabled. It counts every invocation of the function, and flips to ALARM once after the first deploy until the first run.

Also:

- The handler receives exactly `input` (an empty event if none), not an EventBridge rule event. A handler that reads `event["source"]` or `event["detail-type"]` needs `input: { source: 'schedule' }` or a change.
- An ECS target uses the universal `aws-sdk:ecs:runTask` target, because the templated ECS target cannot carry container overrides; `task.containerOverrides` becomes RunTask's overrides. A task that starts and then exits non-zero is still caught by the ECS task-state rule, not by the DLQ.
- A schedule cannot be tagged (only a schedule group can). The repo for a schedule comes from the stack tags on its role, function and queues, which is how the fleet check maps it.
- It throws on the mistakes that went silent in the fleet: a `name` built from `fn.functionName` (a token), a name the queues or the schedule cannot carry (64 characters, letters, digits, `-`, `_`), an `alertsTopic` with a KMS key, a function, cluster or task definition from another stack, both or neither of `fn` and `task`, a cron with no single `?`, and a time zone that is not an IANA name.
- Moving a job from `regelRuleTarget`: use the same `id` and `name`. The onFailure queue and the missed-run alarm keep their logical ids; the rule and its `-eb-dlq` are replaced by the schedule and `-schedule-dlq`. Remove the rule and the `regelRuleTarget` call in the same change.

## What does NOT belong here

This package is **conventions only**. Do not add:
- Actual infrastructure stacks (those live in `regel-aws-infrastructure-primary` or per-service repos)
- Service-specific construct wrappers (those belong in their service repo)
- Secrets Manager paths or SSM lookup helpers (account-codename-scoped; keep out of the shared library so the rename doesn't force a major version bump here)

Keep the surface small. Every export here becomes a breaking-change blast radius.

## Overlap-period contract

During the Claw → regel-core migration (see workspace CLAUDE.md for timeline), BOTH old and new exports resolve to the same boundary ARN and the same tag value behavior as the legacy code. A repo that swaps `import { applyClawTags } from './config/tagging'` for `import { applyClawTags } from 'regel-cdk-conventions'` should produce **zero CloudFormation diff**. If it produces a diff, there's a bug in this package — investigate before shipping.

## See also

- `~/Development/regel/CLAUDE.md` — workspace-level context on the Claw → regel-core rename
- `regel-aws-infrastructure-primary/CLAUDE.md` — foundation stacks repo (the primary consumer of this package)
