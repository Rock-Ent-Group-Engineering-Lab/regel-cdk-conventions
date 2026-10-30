// Offline checks for regelRuleTarget. Runs against the built dist/, like a consumer would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cdk = require('aws-cdk-lib');
const events = require('aws-cdk-lib/aws-events');
const kms = require('aws-cdk-lib/aws-kms');
const lambda = require('aws-cdk-lib/aws-lambda');
const destinations = require('aws-cdk-lib/aws-lambda-destinations');
const sns = require('aws-cdk-lib/aws-sns');
const sqs = require('aws-cdk-lib/aws-sqs');
const { Annotations, Match, Template } = require('aws-cdk-lib/assertions');
const conventions = require('../dist/index.js');
const { regelRuleTarget } = conventions;

const ENV = { account: '859287179937', region: 'us-east-2' };
const SHARED_TOPIC = 'arn:aws:sns:us-east-2:859287179937:regel-core-pipeline-alerts';

function makeFn(stack, id, functionName) {
  return new lambda.Function(stack, id, {
    functionName,
    runtime: lambda.Runtime.PYTHON_3_12,
    handler: 'index.handler',
    code: lambda.Code.fromInline('def handler(event, context):\n    pass\n'),
  });
}

function sample(opts = {}) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'T', { env: ENV });
  const fn = makeFn(stack, 'Fn', 'regel-core-sample-sync');
  const rule = new events.Rule(stack, 'Rule', {
    schedule: events.Schedule.expression('cron(0 5 * * ? *)'),
    enabled: opts.enabled,
  });
  const result = regelRuleTarget(stack, 'Sync', {
    rule, fn, name: 'regel-core-sample-sync', missedRunAfter: cdk.Duration.hours(26), ...(opts.props ?? {}),
  });
  return { app, stack, fn, rule, result, template: Template.fromStack(stack) };
}

const resourcesOfType = (template, type) =>
  Object.entries(template.toJSON().Resources).filter(([, r]) => r.Type === type);

// ── queues ────────────────────────────────────────────────────────────────────

test('both queues have literal names and live next to the function', () => {
  const { template } = sample();
  const names = resourcesOfType(template, 'AWS::SQS::Queue').map(([, r]) => r.Properties.QueueName).sort();
  assert.deepEqual(names, ['regel-core-sample-sync-eb-dlq', 'regel-core-sample-sync-onfailure-dlq']);
  for (const name of names) assert.equal(typeof name, 'string', 'a literal, never a Ref or Fn::Join');
});

test('queues use SSE-SQS, 14 days, and never a KMS key', () => {
  const { template } = sample();
  const queues = resourcesOfType(template, 'AWS::SQS::Queue');
  assert.equal(queues.length, 2);
  for (const [, queue] of queues) {
    assert.equal(queue.Properties.KmsMasterKeyId, undefined);
    assert.equal(queue.Properties.KmsDataKeyReusePeriodSeconds, undefined);
    assert.equal(queue.Properties.SqsManagedSseEnabled, true);
    assert.equal(queue.Properties.MessageRetentionPeriod, 14 * 24 * 60 * 60);
  }
  assert.equal(resourcesOfType(template, 'AWS::KMS::Key').length, 0);
  assert.ok(!JSON.stringify(template.toJSON()).includes('kms:'), 'no KMS grant anywhere in the stack');
});

test('both queues refuse plain-HTTP access', () => {
  const { template } = sample();
  const policies = resourcesOfType(template, 'AWS::SQS::QueuePolicy');
  assert.equal(policies.length, 2);
  for (const [, policy] of policies) {
    assert.ok(policy.Properties.PolicyDocument.Statement.some((s) =>
      s.Effect === 'Deny' && s.Condition?.Bool?.['aws:SecureTransport'] === 'false'));
  }
});

// ── the policy is scoped to the rule ─────────────────────────────────────────

test('the rule DLQ policy admits events.amazonaws.com for this rule only', () => {
  const { template } = sample();
  const ruleId = resourcesOfType(template, 'AWS::Events::Rule')[0][0];
  const dlqId = resourcesOfType(template, 'AWS::SQS::Queue')
    .find(([, r]) => r.Properties.QueueName.endsWith('-eb-dlq'))[0];
  const policy = resourcesOfType(template, 'AWS::SQS::QueuePolicy')
    .find(([, r]) => r.Properties.Queues[0].Ref === dlqId)[1];
  const allows = policy.Properties.PolicyDocument.Statement.filter((s) => s.Effect === 'Allow');
  assert.equal(allows.length, 1, 'one Allow, nothing broader');
  const [allow] = allows;
  assert.deepEqual(allow.Principal, { Service: 'events.amazonaws.com' });
  assert.equal(allow.Action, 'sqs:SendMessage');
  assert.deepEqual(allow.Resource, { 'Fn::GetAtt': [dlqId, 'Arn'] });
  assert.deepEqual(allow.Condition, { ArnEquals: { 'aws:SourceArn': { 'Fn::GetAtt': [ruleId, 'Arn'] } } });
});

test('the onFailure queue has no resource policy for EventBridge; only the function role may send', () => {
  const { template } = sample();
  const failId = resourcesOfType(template, 'AWS::SQS::Queue')
    .find(([, r]) => r.Properties.QueueName.endsWith('-onfailure-dlq'))[0];
  const policy = resourcesOfType(template, 'AWS::SQS::QueuePolicy')
    .find(([, r]) => r.Properties.Queues[0].Ref === failId)[1];
  assert.equal(policy.Properties.PolicyDocument.Statement.filter((s) => s.Effect === 'Allow').length, 0);
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
      Action: ['sqs:SendMessage', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl'],
      Effect: 'Allow',
      Resource: { 'Fn::GetAtt': [failId, 'Arn'] },
    })]) },
  });
});

test('two rules in one stack each get a policy pinned to their own rule', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'T', { env: ENV });
  const first = new events.Rule(stack, 'First', { schedule: events.Schedule.rate(cdk.Duration.hours(1)) });
  const second = new events.Rule(stack, 'Second', { schedule: events.Schedule.rate(cdk.Duration.hours(1)) });
  regelRuleTarget(stack, 'A', { rule: first, fn: makeFn(stack, 'FnA', 'regel-core-a-sync'), name: 'regel-core-a-sync' });
  regelRuleTarget(stack, 'B', { rule: second, fn: makeFn(stack, 'FnB', 'regel-core-b-sync'), name: 'regel-core-b-sync' });
  const template = Template.fromStack(stack);
  const sources = resourcesOfType(template, 'AWS::SQS::QueuePolicy')
    .flatMap(([, r]) => r.Properties.PolicyDocument.Statement)
    .filter((s) => s.Effect === 'Allow')
    .map((s) => s.Condition.ArnEquals['aws:SourceArn']['Fn::GetAtt'][0]);
  const ruleIds = resourcesOfType(template, 'AWS::Events::Rule').map(([id]) => id);
  assert.deepEqual(sources.sort(), ruleIds.sort());
});

// ── target and function wiring ───────────────────────────────────────────────

test('the rule target carries the DLQ, 2 retries and 2 hours by default', () => {
  const { template } = sample();
  const dlqId = resourcesOfType(template, 'AWS::SQS::Queue')
    .find(([, r]) => r.Properties.QueueName.endsWith('-eb-dlq'))[0];
  template.hasResourceProperties('AWS::Events::Rule', {
    Targets: [Match.objectLike({
      DeadLetterConfig: { Arn: { 'Fn::GetAtt': [dlqId, 'Arn'] } },
      RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 7200 },
    })],
  });
});

test('the function gets an onFailure SQS destination, 2 retries and 6 hours by default', () => {
  const { template } = sample();
  const failId = resourcesOfType(template, 'AWS::SQS::Queue')
    .find(([, r]) => r.Properties.QueueName.endsWith('-onfailure-dlq'))[0];
  template.resourceCountIs('AWS::Lambda::EventInvokeConfig', 1);
  template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
    DestinationConfig: { OnFailure: { Destination: { 'Fn::GetAtt': [failId, 'Arn'] } } },
    MaximumRetryAttempts: 2,
    MaximumEventAgeInSeconds: 21600,
  });
});

test('retry settings, the event and the topic pass through', () => {
  const topic = sns.Topic.fromTopicArn(new cdk.Stack(new cdk.App(), 'Other', { env: ENV }), 'T',
    'arn:aws:sns:us-east-2:859287179937:regel-core-elsewhere-alerts');
  const { template } = sample({
    props: {
      retryAttempts: 0,
      maxEventAge: cdk.Duration.hours(1),
      asyncRetryAttempts: 0,
      asyncMaxEventAge: cdk.Duration.hours(1),
      event: events.RuleTargetInput.fromObject({ source: 'cron', row_offset: 0 }),
      alertsTopic: topic,
    },
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    Targets: [Match.objectLike({
      Input: '{"source":"cron","row_offset":0}',
      RetryPolicy: { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 3600 },
    })],
  });
  template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 3600 });
  for (const [, alarm] of resourcesOfType(template, 'AWS::CloudWatch::Alarm')) {
    assert.deepEqual(alarm.Properties.AlarmActions, ['arn:aws:sns:us-east-2:859287179937:regel-core-elsewhere-alerts']);
  }
});

test('an event-pattern rule on a custom bus works the same way', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'T', { env: ENV });
  const bus = new events.EventBus(stack, 'Bus', { eventBusName: 'regel-core-sample-bus' });
  const rule = new events.Rule(stack, 'OnEvent', { eventBus: bus, eventPattern: { source: ['sample'] } });
  const result = regelRuleTarget(stack, 'Loader', {
    rule, fn: makeFn(stack, 'Loader', 'regel-core-sample-loader'), name: 'regel-core-sample-loader',
  });
  const template = Template.fromStack(stack);
  assert.equal(result.missedRunAlarm, undefined);
  template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
});

// ── alarms ───────────────────────────────────────────────────────────────────

test('depth alarms: >= 1 visible message in one window, to the shared topic, alarm action only', () => {
  const { template } = sample();
  const alarms = resourcesOfType(template, 'AWS::CloudWatch::Alarm')
    .map(([, r]) => r.Properties).filter((p) => p.MetricName === 'ApproximateNumberOfMessagesVisible');
  assert.deepEqual(alarms.map((a) => a.AlarmName).sort(), [
    'regel-core-sample-sync-eb-dlq-not-empty',
    'regel-core-sample-sync-onfailure-dlq-not-empty',
  ]);
  for (const alarm of alarms) {
    assert.equal(alarm.Namespace, 'AWS/SQS');
    assert.equal(alarm.Statistic, 'Maximum');
    assert.equal(alarm.Period, 300);
    assert.equal(alarm.Threshold, 1);
    assert.equal(alarm.EvaluationPeriods, 1);
    assert.equal(alarm.DatapointsToAlarm, undefined, 'not an M-of-N shape: it must fire on the first failure');
    assert.equal(alarm.ComparisonOperator, 'GreaterThanOrEqualToThreshold');
    assert.equal(alarm.TreatMissingData, 'notBreaching');
  }
});

test('every alarm is wired to the shared alerts topic, alarm action only', () => {
  const { template } = sample();
  const alarms = resourcesOfType(template, 'AWS::CloudWatch::Alarm');
  assert.equal(alarms.length, 3);
  for (const [, alarm] of alarms) {
    assert.deepEqual(alarm.Properties.AlarmActions, [SHARED_TOPIC]);
    assert.equal(alarm.Properties.OKActions, undefined);
    assert.equal(alarm.Properties.InsufficientDataActions, undefined);
  }
});

test('each depth alarm watches its own queue', () => {
  const { template } = sample();
  for (const [queueId, queue] of resourcesOfType(template, 'AWS::SQS::Queue')) {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: `${queue.Properties.QueueName}-not-empty`,
      Dimensions: [{ Name: 'QueueName', Value: { 'Fn::GetAtt': [queueId, 'QueueName'] } }],
    });
  }
});

test('missed-run alarm: Invocations < 1 over the window, missing data breaches', () => {
  const { template, result } = sample();
  assert.ok(result.missedRunAlarm);
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmName: 'regel-core-sample-sync-missed-run',
    Namespace: 'AWS/Lambda',
    MetricName: 'Invocations',
    Statistic: 'Sum',
    Period: 26 * 60 * 60,
    EvaluationPeriods: 1,
    Threshold: 1,
    ComparisonOperator: 'LessThanThreshold',
    TreatMissingData: 'breaching',
  });
});

test('no missed-run alarm unless asked for', () => {
  const { template, result } = sample({ props: { missedRunAfter: undefined } });
  assert.equal(result.missedRunAlarm, undefined);
  template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
});

test('no missed-run alarm while the rule is disabled; it says so', () => {
  const { template, result, stack } = sample({ enabled: false });
  assert.equal(result.missedRunAlarm, undefined);
  template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
  Annotations.fromStack(stack).hasInfo('/T', Match.stringLikeRegexp('rule is disabled'));
});

test('missedRunAfter must be whole minutes, at least 1 minute, at most 6 days', () => {
  for (const bad of [cdk.Duration.seconds(30), cdk.Duration.seconds(90), cdk.Duration.days(7)]) {
    assert.throws(() => sample({ props: { missedRunAfter: bad } }), /missedRunAfter/);
  }
  assert.doesNotThrow(() => sample({ props: { missedRunAfter: cdk.Duration.days(6) } }));
  assert.doesNotThrow(() => sample({ props: { missedRunAfter: cdk.Duration.minutes(90) } }));
});

test('alarm and queue strings are plain ASCII', () => {
  const { template } = sample();
  for (const [, alarm] of resourcesOfType(template, 'AWS::CloudWatch::Alarm')) {
    assert.match(alarm.Properties.AlarmName, /^[\x20-\x7e]+$/);
    assert.match(alarm.Properties.AlarmDescription, /^[\x20-\x7e]+$/);
  }
});

// ── guards ───────────────────────────────────────────────────────────────────

test('a name built from the function is rejected: it would be a dependency cycle', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'T', { env: ENV });
  const fn = makeFn(stack, 'Fn', 'regel-core-sample-sync');
  const rule = new events.Rule(stack, 'Rule', { schedule: events.Schedule.rate(cdk.Duration.hours(1)) });
  assert.throws(
    () => regelRuleTarget(stack, 'Sync', { rule, fn, name: fn.functionName }),
    /literal string/,
  );
  assert.throws(
    () => regelRuleTarget(stack, 'Sync2', { rule, fn, name: `${fn.functionName}-x` }),
    /literal string/,
  );
});

test('names the queues cannot carry are rejected', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'T', { env: ENV });
  const fn = makeFn(stack, 'Fn', 'f');
  const rule = new events.Rule(stack, 'Rule', { schedule: events.Schedule.rate(cdk.Duration.hours(1)) });
  for (const name of ['has space', 'dots.not.allowed', '', 'x'.repeat(67)]) {
    assert.throws(() => regelRuleTarget(stack, 'Bad', { rule, fn, name }), /name/);
  }
  assert.doesNotThrow(() => regelRuleTarget(stack, 'Ok', { rule, fn, name: 'x'.repeat(66) }));
});

test('a KMS-encrypted alerts topic is rejected: CloudWatch and EventBridge cannot publish to it', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'T', { env: ENV });
  const fn = makeFn(stack, 'Fn', 'regel-core-sample-sync');
  const rule = new events.Rule(stack, 'Rule', { schedule: events.Schedule.rate(cdk.Duration.hours(1)) });
  const encrypted = new sns.Topic(stack, 'Encrypted', { masterKey: new kms.Key(stack, 'Key') });
  assert.throws(
    () => regelRuleTarget(stack, 'Sync', { rule, fn, name: 'regel-core-sample-sync', alertsTopic: encrypted }),
    /KMS-encrypted/,
  );
  const plain = new sns.Topic(stack, 'Plain');
  assert.doesNotThrow(() => regelRuleTarget(stack, 'Sync', { rule, fn, name: 'regel-core-sample-sync', alertsTopic: plain }));
});

test('a rule or function from another stack is rejected', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'T', { env: ENV });
  const other = new cdk.Stack(app, 'Other', { env: ENV });
  const fn = makeFn(stack, 'Fn', 'regel-core-sample-sync');
  const rule = new events.Rule(other, 'Rule', { schedule: events.Schedule.rate(cdk.Duration.hours(1)) });
  assert.throws(() => regelRuleTarget(stack, 'Sync', { rule, fn, name: 'regel-core-sample-sync' }), /same stack/);
});

// ── no circular dependency ───────────────────────────────────────────────────
// CDK builds no cycle check into synth (CloudFormation rejects a cycle at deploy), but the
// assertions library does: Template.fromStack throws "Template is undeployable" on one. Every
// test above goes through it; these two make it explicit and prove it bites.

test('the sample stack has no circular dependency', () => {
  const { stack } = sample();
  assert.doesNotThrow(() => Template.fromStack(stack, { skipCyclicalDependenciesCheck: false }));
});

test('the check does catch the cycle the helper exists to avoid', () => {
  // Control: the same wiring by hand, with the queue named from the function (the uptop PR shape).
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'T', { env: ENV });
  const fn = makeFn(stack, 'Fn', 'regel-core-sample-sync');
  const queue = new sqs.Queue(stack, 'Q', { queueName: `${fn.functionName}-onfailure-dlq` });
  fn.configureAsyncInvoke({ onFailure: new destinations.SqsDestination(queue) });
  assert.throws(() => Template.fromStack(stack), /dependency cycle/);
});

// ── additive release ─────────────────────────────────────────────────────────

test('every export of v1.3.4 is still there', () => {
  const v134 = [
    'REGEL_CORE_ACCOUNT', 'REGEL_CORE_REGION', 'REGEL_CORE_PROFILE', 'REGEL_CORE_ENV',
    'REGEL_CORE_BOUNDARY_ARN', 'CLAW_BOUNDARY_ARN',
    'applyRegelCoreTags', 'applyClawTags',
    'regelCoreSynthesizer', 'regelCoreBootstrapSynthesizer',
    'REGEL_BEDROCK_MODELS', 'RegelAppInferenceProfile', 'bedrockInvokeResources',
    'mcpLambdaAlarms',
  ];
  for (const name of v134) assert.ok(name in conventions, `${name} is exported`);
  assert.equal(typeof regelRuleTarget, 'function');
});
