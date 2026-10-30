// Offline checks for regelSchedule. Runs against the built dist/, like a consumer would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cdk = require('aws-cdk-lib');
const ec2 = require('aws-cdk-lib/aws-ec2');
const ecs = require('aws-cdk-lib/aws-ecs');
const events = require('aws-cdk-lib/aws-events');
const kms = require('aws-cdk-lib/aws-kms');
const lambda = require('aws-cdk-lib/aws-lambda');
const sns = require('aws-cdk-lib/aws-sns');
const { Annotations, Match, Template } = require('aws-cdk-lib/assertions');
const conventions = require('../dist/index.js');
const { regelSchedule, regelRuleTarget } = conventions;

const ENV = { account: '859287179937', region: 'us-east-2' };
const SHARED_TOPIC = 'arn:aws:sns:us-east-2:859287179937:regel-core-pipeline-alerts';
const NAME = 'regel-core-sample-digest';

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
  const fn = makeFn(stack, 'Fn', NAME);
  const result = regelSchedule(stack, 'Digest', {
    fn, name: NAME, schedule: 'cron(15 7 ? * MON-FRI *)', missedRunAfter: cdk.Duration.hours(26), ...(opts.props ?? {}),
  });
  return { app, stack, fn, result, template: Template.fromStack(stack) };
}

function sampleTask(opts = {}) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'T', { env: ENV });
  const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2 });
  const cluster = new ecs.Cluster(stack, 'Cluster', { vpc, clusterName: 'regel-core-sample' });
  const taskDefinition = new ecs.FargateTaskDefinition(stack, 'TaskDef');
  taskDefinition.addContainer('sync', { image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/busybox') });
  const sg = new ec2.SecurityGroup(stack, 'Sg', { vpc });
  const result = regelSchedule(stack, 'Nightly', {
    name: 'regel-core-sample-nightly',
    schedule: 'cron(0 2 * * ? *)',
    task: {
      cluster, taskDefinition, securityGroups: [sg],
      containerOverrides: [{ name: 'sync', command: ['python', 'reconcile.py'], environment: { SECRET_PREFIX: 'regel-core-sample' } }],
      ...(opts.task ?? {}),
    },
    ...(opts.props ?? {}),
  });
  return { app, stack, result, template: Template.fromStack(stack) };
}

const resourcesOfType = (template, type) =>
  Object.entries(template.toJSON().Resources).filter(([, r]) => r.Type === type);
const schedulerRole = (template) =>
  resourcesOfType(template, 'AWS::IAM::Role')
    .find(([, r]) => r.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service === 'scheduler.amazonaws.com');
const queueId = (template, suffix) =>
  resourcesOfType(template, 'AWS::SQS::Queue').find(([, r]) => r.Properties.QueueName.endsWith(suffix))[0];

// ── the schedule ─────────────────────────────────────────────────────────────

test('the schedule: cron in Eastern time, flexible window off, enabled, in the default group', () => {
  const { template } = sample();
  template.resourceCountIs('AWS::Scheduler::Schedule', 1);
  template.hasResourceProperties('AWS::Scheduler::Schedule', {
    Name: NAME,
    ScheduleExpression: 'cron(15 7 ? * MON-FRI *)',
    ScheduleExpressionTimezone: 'America/New_York',
    FlexibleTimeWindow: { Mode: 'OFF' },
    State: 'ENABLED',
  });
  const [[, schedule]] = resourcesOfType(template, 'AWS::Scheduler::Schedule');
  assert.equal(schedule.Properties.GroupName, undefined, 'the default group');
});

test('another time zone and a disabled schedule pass through', () => {
  const { template } = sample({ props: { timeZone: 'America/Chicago', enabled: false } });
  template.hasResourceProperties('AWS::Scheduler::Schedule', { ScheduleExpressionTimezone: 'America/Chicago', State: 'DISABLED' });
});

test('a rate expression carries no time zone', () => {
  const { template } = sample({ props: { schedule: 'rate(10 minutes)' } });
  template.hasResourceProperties('AWS::Scheduler::Schedule', { ScheduleExpression: 'rate(10 minutes)' });
  const [[, schedule]] = resourcesOfType(template, 'AWS::Scheduler::Schedule');
  assert.equal(schedule.Properties.ScheduleExpressionTimezone, undefined);
});

test('the target: the function, the role, 2 retries over 2 hours, the DLQ, and no input unless given', () => {
  const { template } = sample();
  const roleId = schedulerRole(template)[0];
  const fnId = resourcesOfType(template, 'AWS::Lambda::Function')[0][0];
  template.hasResourceProperties('AWS::Scheduler::Schedule', {
    Target: {
      Arn: { 'Fn::GetAtt': [fnId, 'Arn'] },
      RoleArn: { 'Fn::GetAtt': [roleId, 'Arn'] },
      RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 7200 },
      DeadLetterConfig: { Arn: { 'Fn::GetAtt': [queueId(template, '-schedule-dlq'), 'Arn'] } },
    },
  });
  const [[, schedule]] = resourcesOfType(template, 'AWS::Scheduler::Schedule');
  assert.equal(schedule.Properties.Target.Input, undefined);
});

test('input, retry settings and the topic pass through', () => {
  const topic = sns.Topic.fromTopicArn(new cdk.Stack(new cdk.App(), 'Other', { env: ENV }), 'T',
    'arn:aws:sns:us-east-2:859287179937:regel-core-elsewhere-alerts');
  const { template } = sample({
    props: {
      input: { source: 'schedule', recipients: 'test' },
      retryAttempts: 0, maxEventAge: cdk.Duration.minutes(30),
      asyncRetryAttempts: 0, asyncMaxEventAge: cdk.Duration.hours(1),
      alertsTopic: topic, description: 'Weekday digest',
    },
  });
  template.hasResourceProperties('AWS::Scheduler::Schedule', {
    Description: 'Weekday digest',
    Target: Match.objectLike({
      Input: '{"source":"schedule","recipients":"test"}',
      RetryPolicy: { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 1800 },
    }),
  });
  template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 3600 });
  for (const [, alarm] of resourcesOfType(template, 'AWS::CloudWatch::Alarm')) {
    assert.deepEqual(alarm.Properties.AlarmActions, ['arn:aws:sns:us-east-2:859287179937:regel-core-elsewhere-alerts']);
  }
});

// ── the execution role ───────────────────────────────────────────────────────

test('the role trusts Scheduler for this account and the default schedule group, nothing else', () => {
  const { template } = sample();
  const [, role] = schedulerRole(template);
  const [statement] = role.Properties.AssumeRolePolicyDocument.Statement;
  assert.equal(role.Properties.AssumeRolePolicyDocument.Statement.length, 1);
  assert.deepEqual(statement.Principal, { Service: 'scheduler.amazonaws.com' });
  assert.equal(statement.Action, 'sts:AssumeRole');
  assert.deepEqual(statement.Condition.StringEquals, { 'aws:SourceAccount': '859287179937' });
  assert.deepEqual(Object.keys(statement.Condition).sort(), ['ArnLike', 'StringEquals']);
  // The ARN carries the partition as a reference; a schedule GROUP, never a schedule or a prefix.
  assert.deepEqual(statement.Condition.ArnLike['aws:SourceArn']['Fn::Join'][1].slice(2), [':scheduler:us-east-2:859287179937:schedule-group/default']);
});

test('the role may invoke this function and send to this DLQ, and do nothing else', () => {
  const { template } = sample();
  const fnId = resourcesOfType(template, 'AWS::Lambda::Function')[0][0];
  const dlq = queueId(template, '-schedule-dlq');
  const roleId = schedulerRole(template)[0];
  const policy = resourcesOfType(template, 'AWS::IAM::Policy')
    .find(([, p]) => p.Properties.Roles.some((r) => r.Ref === roleId))[1];
  const statements = policy.Properties.PolicyDocument.Statement;
  assert.equal(statements.length, 2);
  const byAction = Object.fromEntries(statements.map((s) => [[].concat(s.Action).join(','), s]));
  assert.deepEqual(Object.keys(byAction).sort(), ['lambda:InvokeFunction', 'sqs:SendMessage']);
  assert.deepEqual(byAction['sqs:SendMessage'].Resource, { 'Fn::GetAtt': [dlq, 'Arn'] });
  assert.deepEqual(byAction['lambda:InvokeFunction'].Resource[0], { 'Fn::GetAtt': [fnId, 'Arn'] });
  for (const s of statements) assert.equal(s.Effect, 'Allow');
});

test('the schedule waits for its role', () => {
  const { template } = sample();
  const roleId = schedulerRole(template)[0];
  const [[, schedule]] = resourcesOfType(template, 'AWS::Scheduler::Schedule');
  assert.ok(schedule.DependsOn.includes(roleId));
  assert.ok(schedule.DependsOn.some((d) => d.startsWith('DigestRoleDefaultPolicy')));
});

// ── queues ───────────────────────────────────────────────────────────────────

test('both queues have literal names', () => {
  const { template } = sample();
  const names = resourcesOfType(template, 'AWS::SQS::Queue').map(([, r]) => r.Properties.QueueName).sort();
  assert.deepEqual(names, [`${NAME}-onfailure-dlq`, `${NAME}-schedule-dlq`]);
  for (const name of names) assert.equal(typeof name, 'string', 'a literal, never a Ref or Fn::Join');
});

test('queues use SSE-SQS, 14 days, TLS only, and never a KMS key', () => {
  const { template } = sample();
  const queues = resourcesOfType(template, 'AWS::SQS::Queue');
  assert.equal(queues.length, 2);
  for (const [, queue] of queues) {
    assert.equal(queue.Properties.KmsMasterKeyId, undefined);
    assert.equal(queue.Properties.SqsManagedSseEnabled, true);
    assert.equal(queue.Properties.MessageRetentionPeriod, 14 * 24 * 60 * 60);
  }
  const policies = resourcesOfType(template, 'AWS::SQS::QueuePolicy');
  assert.equal(policies.length, 2);
  for (const [, policy] of policies) {
    assert.ok(policy.Properties.PolicyDocument.Statement.some((s) =>
      s.Effect === 'Deny' && s.Condition?.Bool?.['aws:SecureTransport'] === 'false'));
    assert.equal(policy.Properties.PolicyDocument.Statement.filter((s) => s.Effect === 'Allow').length, 0,
      'no resource policy for the event services: the role sends with its own permission');
  }
  assert.equal(resourcesOfType(template, 'AWS::KMS::Key').length, 0);
  assert.ok(!JSON.stringify(template.toJSON()).includes('kms:'), 'no KMS grant anywhere in the stack');
});

// ── the function's failure path ──────────────────────────────────────────────

test('the function gets an onFailure SQS destination, 2 retries and 6 hours by default', () => {
  const { template } = sample();
  template.resourceCountIs('AWS::Lambda::EventInvokeConfig', 1);
  template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
    DestinationConfig: { OnFailure: { Destination: { 'Fn::GetAtt': [queueId(template, '-onfailure-dlq'), 'Arn'] } } },
    MaximumRetryAttempts: 2,
    MaximumEventAgeInSeconds: 21600,
  });
});

test('onFailure: false leaves the function alone and makes no second queue', () => {
  const { template, result } = sample({ props: { onFailure: false } });
  assert.equal(result.onFailureDlq, undefined);
  assert.equal(result.onFailureDlqAlarm, undefined);
  template.resourceCountIs('AWS::Lambda::EventInvokeConfig', 0);
  assert.deepEqual(resourcesOfType(template, 'AWS::SQS::Queue').map(([, r]) => r.Properties.QueueName), [`${NAME}-schedule-dlq`]);
});

test('two schedules on one function: the second passes onFailure: false', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'T', { env: ENV });
  const fn = makeFn(stack, 'Fn', 'regel-core-sample-refresh');
  regelSchedule(stack, 'Hourly', { fn, name: 'regel-core-sample-refresh-hourly', schedule: 'rate(1 hour)' });
  assert.throws(
    () => regelSchedule(stack, 'Nightly', { fn, name: 'regel-core-sample-refresh-nightly', schedule: 'cron(5 0 * * ? *)' }),
    /already has an async invoke config.*onFailure: false/s,
  );
  regelSchedule(stack, 'Nightly', { fn, name: 'regel-core-sample-refresh-nightly', schedule: 'cron(5 0 * * ? *)', onFailure: false });
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::Scheduler::Schedule', 2);
  template.resourceCountIs('AWS::Lambda::EventInvokeConfig', 1);
  assert.equal(resourcesOfType(template, 'AWS::SQS::Queue').length, 3);
});

test('async settings with onFailure: false are refused: they would do nothing', () => {
  assert.throws(() => sample({ props: { onFailure: false, asyncRetryAttempts: 0 } }), /onFailure: false/);
});

// ── alarms ───────────────────────────────────────────────────────────────────

test('depth alarms: >= 1 visible message in one window, each on its own queue, alarm action only', () => {
  const { template } = sample();
  const alarms = resourcesOfType(template, 'AWS::CloudWatch::Alarm')
    .filter(([, r]) => r.Properties.MetricName === 'ApproximateNumberOfMessagesVisible');
  assert.deepEqual(alarms.map(([, a]) => a.Properties.AlarmName).sort(), [`${NAME}-onfailure-dlq-not-empty`, `${NAME}-schedule-dlq-not-empty`]);
  for (const [, { Properties: alarm }] of alarms) {
    assert.equal(alarm.Namespace, 'AWS/SQS');
    assert.equal(alarm.Statistic, 'Maximum');
    assert.equal(alarm.Period, 300);
    assert.equal(alarm.Threshold, 1);
    assert.equal(alarm.EvaluationPeriods, 1);
    assert.equal(alarm.DatapointsToAlarm, undefined, 'not an M-of-N shape: it must fire on the first failure');
    assert.equal(alarm.ComparisonOperator, 'GreaterThanOrEqualToThreshold');
    assert.equal(alarm.TreatMissingData, 'notBreaching');
  }
  for (const [id, queue] of resourcesOfType(template, 'AWS::SQS::Queue')) {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: `${queue.Properties.QueueName}-not-empty`,
      Dimensions: [{ Name: 'QueueName', Value: { 'Fn::GetAtt': [id, 'QueueName'] } }],
    });
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

test('missed-run alarm: Invocations < 1 over the window, missing data breaches', () => {
  const { template, result } = sample();
  assert.ok(result.missedRunAlarm);
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmName: `${NAME}-missed-run`,
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

test('no missed-run alarm unless asked for, and none while the schedule is disabled (it says so)', () => {
  const plain = sample({ props: { missedRunAfter: undefined } });
  assert.equal(plain.result.missedRunAlarm, undefined);
  plain.template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
  const off = sample({ props: { enabled: false } });
  assert.equal(off.result.missedRunAlarm, undefined);
  off.template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
  Annotations.fromStack(off.stack).hasInfo('/T', Match.stringLikeRegexp('schedule is disabled'));
});

test('missedRunAfter must be whole minutes, at least 1 minute, at most 6 days', () => {
  for (const bad of [cdk.Duration.seconds(30), cdk.Duration.seconds(90), cdk.Duration.days(7)]) {
    assert.throws(() => sample({ props: { missedRunAfter: bad } }), /missedRunAfter/);
  }
  assert.doesNotThrow(() => sample({ props: { missedRunAfter: cdk.Duration.days(6) } }));
});

test('alarm, queue and schedule strings are plain ASCII', () => {
  const { template } = sample();
  for (const [, alarm] of resourcesOfType(template, 'AWS::CloudWatch::Alarm')) {
    assert.match(alarm.Properties.AlarmName, /^[\x20-\x7e]+$/);
    assert.match(alarm.Properties.AlarmDescription, /^[\x20-\x7e]+$/);
  }
  for (const [, role] of resourcesOfType(template, 'AWS::IAM::Role')) assert.match(role.Properties.Description ?? '', /^[\x20-\x7e]*$/);
  const [[, schedule]] = resourcesOfType(template, 'AWS::Scheduler::Schedule');
  assert.match(schedule.Properties.Description, /^[\x20-\x7e]+$/);
});

// ── an ECS task target ───────────────────────────────────────────────────────

test('an ECS target runs through the universal runTask target with the container overrides as RunTask overrides', () => {
  const { template } = sampleTask();
  const [[, schedule]] = resourcesOfType(template, 'AWS::Scheduler::Schedule');
  assert.equal(schedule.Properties.Target.Arn, 'arn:aws:scheduler:::aws-sdk:ecs:runTask');
  assert.equal(schedule.Properties.ScheduleExpressionTimezone, 'America/New_York');
  // The input is built with intrinsics (cluster ARN, task definition ARN, subnets, security group); read it as the template renders it.
  const text = JSON.stringify(schedule.Properties.Target.Input);
  for (const needle of ['"Cluster"', '"TaskDefinition"', '"LaunchType":"FARGATE"', '"AssignPublicIp":"DISABLED"', '"Subnets"', '"SecurityGroups"',
    '"Overrides":{"ContainerOverrides":[{"Name":"sync","Command":["python","reconcile.py"],"Environment":[{"Name":"SECRET_PREFIX","Value":"regel-core-sample"}]}]}']) {
    assert.ok(text.replace(/\\"/g, '"').includes(needle), `input carries ${needle}`);
  }
});

test('an ECS target in public subnets gets a public IP, and no overrides means no Overrides key', () => {
  const { template } = sampleTask({ task: { containerOverrides: undefined, vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC } } });
  const [[, schedule]] = resourcesOfType(template, 'AWS::Scheduler::Schedule');
  const text = JSON.stringify(schedule.Properties.Target.Input).replace(/\\"/g, '"');
  assert.ok(text.includes('"AssignPublicIp":"ENABLED"'));
  assert.ok(!text.includes('Overrides'));
});

test('the ECS role may run this task definition and pass its roles, and send to the DLQ; the function-only parts are absent', () => {
  const { template, result } = sampleTask();
  const roleId = schedulerRole(template)[0];
  const policy = resourcesOfType(template, 'AWS::IAM::Policy').find(([, p]) => p.Properties.Roles.some((r) => r.Ref === roleId))[1];
  const actions = policy.Properties.PolicyDocument.Statement.flatMap((s) => [].concat(s.Action)).sort();
  assert.deepEqual(actions, ['ecs:RunTask', 'iam:PassRole', 'sqs:SendMessage']);
  const pass = policy.Properties.PolicyDocument.Statement.find((s) => s.Action === 'iam:PassRole');
  assert.notEqual(pass.Resource, '*', 'only the task definition\'s own roles');
  assert.deepEqual(pass.Condition, { StringLike: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } });
  const run = policy.Properties.PolicyDocument.Statement.find((s) => s.Action === 'ecs:RunTask');
  assert.notEqual(run.Resource, '*', 'only this task definition');
  assert.equal(result.onFailureDlq, undefined);
  assert.equal(result.missedRunAlarm, undefined);
  template.resourceCountIs('AWS::Lambda::EventInvokeConfig', 0);
  assert.deepEqual(resourcesOfType(template, 'AWS::SQS::Queue').map(([, r]) => r.Properties.QueueName), ['regel-core-sample-nightly-schedule-dlq']);
  template.resourceCountIs('AWS::CloudWatch::Alarm', 1);
});

test('an ECS target has no missed-run alarm and takes no Lambda input', () => {
  assert.throws(() => sampleTask({ props: { missedRunAfter: cdk.Duration.hours(26) } }), /Lambda targets/);
  assert.throws(() => sampleTask({ props: { input: { a: 1 } } }), /containerOverrides/);
});

// ── guards ───────────────────────────────────────────────────────────────────

test('a name built from the function is rejected: it would be a dependency cycle', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'T', { env: ENV });
  const fn = makeFn(stack, 'Fn', NAME);
  assert.throws(() => regelSchedule(stack, 'S', { fn, name: fn.functionName, schedule: 'rate(1 hour)' }), /literal string/);
  assert.throws(() => regelSchedule(stack, 'S2', { fn, name: `${fn.functionName}-x`, schedule: 'rate(1 hour)' }), /literal string/);
});

test('names the queues and the schedule cannot carry are rejected', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'T', { env: ENV });
  const fn = makeFn(stack, 'Fn', 'f');
  for (const name of ['has space', 'dots.not.allowed', '', 'x'.repeat(65)]) {
    assert.throws(() => regelSchedule(stack, 'Bad', { fn, name, schedule: 'rate(1 hour)' }), /name/);
  }
  assert.doesNotThrow(() => regelSchedule(stack, 'Ok', { fn, name: 'x'.repeat(64), schedule: 'rate(1 hour)' }));
});

test('a KMS-encrypted alerts topic is rejected: CloudWatch cannot publish to it', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'T', { env: ENV });
  const fn = makeFn(stack, 'Fn', NAME);
  const encrypted = new sns.Topic(stack, 'Encrypted', { masterKey: new kms.Key(stack, 'Key') });
  assert.throws(() => regelSchedule(stack, 'S', { fn, name: NAME, schedule: 'rate(1 hour)', alertsTopic: encrypted }), /KMS-encrypted/);
  const plain = new sns.Topic(stack, 'Plain');
  assert.doesNotThrow(() => regelSchedule(stack, 'S', { fn, name: NAME, schedule: 'rate(1 hour)', alertsTopic: plain }));
});

test('a function, cluster or task definition from another stack is rejected', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'T', { env: ENV });
  const other = new cdk.Stack(app, 'Other', { env: ENV });
  const fn = makeFn(other, 'Fn', NAME);
  assert.throws(() => regelSchedule(stack, 'S', { fn, name: NAME, schedule: 'rate(1 hour)' }), /same stack/);
});

test('exactly one target', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'T', { env: ENV });
  assert.throws(() => regelSchedule(stack, 'S', { name: NAME, schedule: 'rate(1 hour)' }), /exactly one target/);
  const fn = makeFn(stack, 'Fn', NAME);
  const vpc = new ec2.Vpc(stack, 'Vpc');
  const cluster = new ecs.Cluster(stack, 'C', { vpc });
  const taskDefinition = new ecs.FargateTaskDefinition(stack, 'TD');
  assert.throws(() => regelSchedule(stack, 'S', { fn, task: { cluster, taskDefinition }, name: NAME, schedule: 'rate(1 hour)' }), /exactly one target/);
});

test('an EC2-only task definition is rejected: scheduled tasks run on Fargate', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'T', { env: ENV });
  const vpc = new ec2.Vpc(stack, 'Vpc');
  const cluster = new ecs.Cluster(stack, 'C', { vpc });
  const taskDefinition = new ecs.Ec2TaskDefinition(stack, 'TD');
  taskDefinition.addContainer('c', { image: ecs.ContainerImage.fromRegistry('busybox'), memoryLimitMiB: 64 });
  assert.throws(() => regelSchedule(stack, 'S', { task: { cluster, taskDefinition }, name: NAME, schedule: 'rate(1 hour)' }), /Fargate/);
});

test('schedule expressions: cron needs one "?", rate needs the right unit, anything else is refused', () => {
  const bad = [
    'cron(0 7 * * * *)', 'cron(0 7 ? * ? *)', 'cron(0 7 * *)', '0 7 * * *', 'at(2026-11-01T07:00:00)',
    'rate(0 minutes)', 'rate(1 hours)', 'rate(5 minute)', 'rate(five minutes)',
  ];
  for (const schedule of bad) {
    assert.throws(() => sample({ props: { schedule } }), /regelSchedule\(Digest\)/, schedule);
  }
  for (const schedule of ['cron(15 7 ? * MON-FRI *)', 'cron(0 5 * * ? *)', 'cron(30 */2 * * ? *)', 'rate(1 hour)', 'rate(10 minutes)', 'rate(1 day)']) {
    assert.doesNotThrow(() => sample({ props: { schedule } }), schedule);
  }
});

test('a time zone that is not an IANA name, and out-of-range retry settings, are refused', () => {
  assert.throws(() => sample({ props: { timeZone: 'Eastern' } }), /timeZone/);
  assert.throws(() => sample({ props: { retryAttempts: 186 } }), /retryAttempts/);
  assert.throws(() => sample({ props: { retryAttempts: -1 } }), /retryAttempts/);
  assert.throws(() => sample({ props: { maxEventAge: cdk.Duration.seconds(30) } }), /maxEventAge/);
  assert.throws(() => sample({ props: { maxEventAge: cdk.Duration.hours(25) } }), /maxEventAge/);
});

// ── no circular dependency, and the old helper is untouched ──────────────────

test('the sample stacks have no circular dependency', () => {
  assert.doesNotThrow(() => Template.fromStack(sample().stack, { skipCyclicalDependenciesCheck: false }));
  assert.doesNotThrow(() => Template.fromStack(sampleTask().stack, { skipCyclicalDependenciesCheck: false }));
});

test('moving a job from regelRuleTarget: the same id and name keep the onFailure queue and the missed-run alarm', () => {
  const build = (useSchedule) => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'T', { env: ENV });
    const fn = makeFn(stack, 'Fn', NAME);
    if (useSchedule) {
      regelSchedule(stack, 'Sync', { fn, name: NAME, schedule: 'cron(0 5 * * ? *)', missedRunAfter: cdk.Duration.hours(26) });
    } else {
      const rule = new events.Rule(stack, 'Rule', { schedule: events.Schedule.expression('cron(0 5 * * ? *)') });
      regelRuleTarget(stack, 'Sync', { rule, fn, name: NAME, missedRunAfter: cdk.Duration.hours(26) });
    }
    return Template.fromStack(stack).toJSON().Resources;
  };
  const before = build(false);
  const after = build(true);
  const find = (resources, prefix) => Object.keys(resources).filter((id) => id.startsWith(prefix) && /^[0-9A-F]{8}$/.test(id.slice(prefix.length)));
  for (const prefix of ['SyncOnFailureDlq', 'SyncOnFailureDlqDepthAlarm', 'SyncMissedRunAlarm']) {
    const [b] = find(before, prefix);
    const [a] = find(after, prefix);
    assert.ok(a && a === b, `${prefix} keeps its logical id`);
    const strip = ({ Properties: { AlarmDescription, ...rest }, ...r }) => ({ ...r, Properties: rest });   // only the wording of the description differs
    assert.deepEqual(strip(after[a]), strip(before[b]), `${prefix} is unchanged`);
  }
  assert.equal(find(before, 'SyncEbDlq').length, 1);
  assert.equal(find(after, 'SyncEbDlq').length, 0, 'the rule queue goes away');
  assert.equal(find(after, 'SyncScheduleDlq').length, 1, 'the schedule queue arrives');
  assert.equal(find(before, 'SyncScheduleDlq').length, 0);
});

test('regelSchedule and the other helpers are all exported', () => {
  assert.equal(typeof regelSchedule, 'function');
  for (const name of ['regelRuleTarget', 'mcpLambdaAlarms', 'applyRegelCoreTags', 'regelCoreSynthesizer', 'RegelAppInferenceProfile']) {
    assert.ok(name in conventions, `${name} is exported`);
  }
});
