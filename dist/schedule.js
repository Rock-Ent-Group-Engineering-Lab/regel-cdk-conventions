"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.regelSchedule = regelSchedule;
const cdk = __importStar(require("aws-cdk-lib"));
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const destinations = __importStar(require("aws-cdk-lib/aws-lambda-destinations"));
const scheduler = __importStar(require("aws-cdk-lib/aws-scheduler"));
const failure_handling_1 = require("./failure-handling");
const DEFAULT_SCHEDULE_TIME_ZONE = 'America/New_York';
/** Scheduler's schedule-name limit; `<name>-onfailure-dlq` (14 more characters) fits SQS's 80 under it. */
const MAX_NAME_LENGTH = 64;
const ECS_RUN_TASK_ARN = 'arn:aws:scheduler:::aws-sdk:ecs:runTask';
function checkExpression(id, expression) {
    const cron = /^cron\(\s*(\S+(?:\s+\S+){5})\s*\)$/.exec(expression);
    if (cron) {
        const fields = cron[1].split(/\s+/);
        const [dayOfMonth, , dayOfWeek] = [fields[2], fields[3], fields[4]];
        if ((dayOfMonth === '?') === (dayOfWeek === '?')) {
            throw new Error(`regelSchedule(${id}): "${expression}" must have "?" in exactly one of day-of-month and day-of-week ` +
                '(Scheduler cron is minute hour day-of-month month day-of-week year).');
        }
        return 'cron';
    }
    const rate = /^rate\(\s*(\d+) (minute|minutes|hour|hours|day|days)\s*\)$/.exec(expression);
    if (rate) {
        const plural = rate[2].endsWith('s');
        if (Number(rate[1]) < 1 || (Number(rate[1]) === 1) === plural) {
            throw new Error(`regelSchedule(${id}): "${expression}" must be a positive number, with the singular unit for 1 ` +
                '("rate(1 hour)") and the plural otherwise ("rate(2 hours)").');
        }
        return 'rate';
    }
    throw new Error(`regelSchedule(${id}): schedule "${expression}" must be cron(minute hour day-of-month month day-of-week year) ` +
        'or rate(<n> minutes|hours|days). One-time at(...) schedules are not covered.');
}
function checkTimeZone(id, timeZone) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone });
    }
    catch {
        throw new Error(`regelSchedule(${id}): timeZone "${timeZone}" is not an IANA time zone name such as America/New_York.`);
    }
}
function regelSchedule(scope, id, props) {
    const { name } = props;
    (0, failure_handling_1.checkLiteralName)('regelSchedule', id, name, MAX_NAME_LENGTH, 'a schedule name is at most 64, and "<name>-onfailure-dlq" has to fit SQS\'s 80');
    if ((props.fn === undefined) === (props.task === undefined)) {
        throw new Error(`regelSchedule(${id}): give exactly one target, \`fn\` (a Lambda) or \`task\` (an ECS Fargate task).`);
    }
    const stack = cdk.Stack.of(scope);
    const inScope = [props.fn, props.task?.cluster, props.task?.taskDefinition].filter((c) => c !== undefined);
    if (inScope.some((c) => cdk.Stack.of(c) !== stack)) {
        throw new Error(`regelSchedule(${id}): the target and the scope must be in the same stack ` +
            '(the role grants and the failure queues would otherwise cross stacks and cycle).');
    }
    const kind = checkExpression(id, props.schedule);
    const timeZone = props.timeZone ?? DEFAULT_SCHEDULE_TIME_ZONE;
    if (!cdk.Token.isUnresolved(timeZone))
        checkTimeZone(id, timeZone);
    if ((props.description ?? '').length > 512) {
        throw new Error(`regelSchedule(${id}): description is at most 512 characters.`);
    }
    const retryAttempts = props.retryAttempts ?? 2;
    if (!Number.isInteger(retryAttempts) || retryAttempts < 0 || retryAttempts > 185) {
        throw new Error(`regelSchedule(${id}): retryAttempts must be a whole number from 0 to 185.`);
    }
    const maxEventAge = props.maxEventAge ?? cdk.Duration.hours(2);
    if (maxEventAge.toSeconds() < 60 || maxEventAge.toSeconds() > 24 * 60 * 60) {
        throw new Error(`regelSchedule(${id}): maxEventAge must be between 1 minute and 24 hours.`);
    }
    if (props.input !== undefined && props.fn === undefined) {
        throw new Error(`regelSchedule(${id}): \`input\` is for a Lambda target; an ECS target takes task.containerOverrides.`);
    }
    if (props.missedRunAfter && props.fn === undefined) {
        throw new Error(`regelSchedule(${id}): missedRunAfter needs the function's Invocations metric, so it is for Lambda targets. ` +
            'Scheduler publishes per schedule group, not per schedule, so an ECS job needs a freshness metric of its own.');
    }
    (0, failure_handling_1.checkMissedRunWindow)('regelSchedule', id, props.missedRunAfter, 'schedule');
    const wantOnFailure = props.fn !== undefined && (props.onFailure ?? true);
    if (props.fn !== undefined && !wantOnFailure && (props.asyncRetryAttempts !== undefined || props.asyncMaxEventAge !== undefined)) {
        throw new Error(`regelSchedule(${id}): asyncRetryAttempts and asyncMaxEventAge belong to the onFailure config; they have nothing to set with onFailure: false.`);
    }
    if (wantOnFailure && props.fn.node.tryFindChild('EventInvokeConfig') !== undefined) {
        throw new Error(`regelSchedule(${id}): the function already has an async invoke config (an earlier regelSchedule or ` +
            'regelRuleTarget call on it, or your own configureAsyncInvoke), and a function takes only one. Pass ' +
            '`onFailure: false` on this schedule.');
    }
    const alert = (0, failure_handling_1.alertAction)('regelSchedule', scope, id, props.alertsTopic);
    const enabled = props.enabled ?? true;
    const dlqName = `${name}-schedule-dlq`;
    const onFailureQueueName = `${name}-onfailure-dlq`;
    const dlq = (0, failure_handling_1.failureQueue)(scope, `${id}ScheduleDlq`, dlqName);
    // The role: Scheduler may assume it for a schedule in this account's default group, and it may do two
    // things, invoke this target and send to this DLQ.
    const role = new iam.Role(scope, `${id}Role`, {
        assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
            conditions: {
                StringEquals: { 'aws:SourceAccount': stack.account },
                ArnLike: { 'aws:SourceArn': stack.formatArn({ service: 'scheduler', resource: 'schedule-group', resourceName: 'default' }) },
            },
        }),
        description: `EventBridge Scheduler: run ${name} (invoke the target, send failures to its DLQ)`,
    });
    role.addToPolicy(new iam.PolicyStatement({ sid: 'SendToDlq', actions: ['sqs:SendMessage'], resources: [dlq.queueArn] }));
    let targetArn;
    let targetInput;
    if (props.fn !== undefined) {
        props.fn.grantInvoke(role);
        targetArn = props.fn.functionArn;
        targetInput = props.input === undefined ? undefined : stack.toJsonString(props.input);
    }
    else {
        const task = props.task;
        if (!task.taskDefinition.isFargateCompatible) {
            throw new Error(`regelSchedule(${id}): the task definition must be Fargate compatible (REGEL runs scheduled tasks on Fargate).`);
        }
        if (!task.cluster.vpc) {
            throw new Error(`regelSchedule(${id}): the cluster needs its VPC (pass it as \`vpc\` when you import the cluster) so the subnets can be picked.`);
        }
        task.taskDefinition.grantRun(role);
        const subnetSelection = task.vpcSubnets ?? { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };
        const assignPublicIp = task.assignPublicIp ?? subnetSelection.subnetType === ec2.SubnetType.PUBLIC;
        const overrides = (task.containerOverrides ?? []).map((o) => ({
            Name: o.name,
            ...(o.command ? { Command: o.command } : {}),
            ...(o.environment ? { Environment: Object.entries(o.environment).map(([Name, Value]) => ({ Name, Value })) } : {}),
        }));
        targetArn = ECS_RUN_TASK_ARN;
        targetInput = stack.toJsonString({
            Cluster: task.cluster.clusterArn,
            TaskDefinition: task.taskDefinition.taskDefinitionArn,
            LaunchType: 'FARGATE',
            PlatformVersion: 'LATEST',
            Count: 1,
            NetworkConfiguration: {
                AwsvpcConfiguration: {
                    Subnets: task.cluster.vpc.selectSubnets(subnetSelection).subnetIds,
                    ...(task.securityGroups?.length ? { SecurityGroups: task.securityGroups.map((sg) => sg.securityGroupId) } : {}),
                    AssignPublicIp: assignPublicIp ? 'ENABLED' : 'DISABLED',
                },
            },
            ...(overrides.length ? { Overrides: { ContainerOverrides: overrides } } : {}),
        });
    }
    const schedule = new scheduler.CfnSchedule(scope, `${id}Schedule`, {
        name,
        description: props.description ?? name,
        scheduleExpression: props.schedule,
        ...(kind === 'cron' ? { scheduleExpressionTimezone: timeZone } : {}),
        flexibleTimeWindow: { mode: 'OFF' },
        state: enabled ? 'ENABLED' : 'DISABLED',
        target: {
            arn: targetArn,
            roleArn: role.roleArn,
            ...(targetInput === undefined ? {} : { input: targetInput }),
            retryPolicy: { maximumRetryAttempts: retryAttempts, maximumEventAgeInSeconds: maxEventAge.toSeconds() },
            deadLetterConfig: { arn: dlq.queueArn },
        },
    });
    // The role and the queue must exist before the schedule that uses them is created.
    schedule.node.addDependency(role);
    const dlqAlarm = (0, failure_handling_1.depthAlarm)(scope, `${id}ScheduleDlqDepthAlarm`, dlq, dlqName, `${name}: EventBridge Scheduler could not deliver a run to the target (throttled, permission, or target ` +
        `missing, or ECS refused RunTask). The event is waiting in ${dlqName}; read it, fix the cause, then ` +
        'redrive or purge. Errors a Lambda handler raises do not land here' +
        (wantOnFailure ? `, see ${onFailureQueueName}.` : ', they go to the function\'s own onFailure queue.'), alert);
    let onFailureDlq;
    let onFailureDlqAlarm;
    if (wantOnFailure) {
        const fn = props.fn;
        onFailureDlq = (0, failure_handling_1.failureQueue)(scope, `${id}OnFailureDlq`, onFailureQueueName);
        fn.configureAsyncInvoke({
            onFailure: new destinations.SqsDestination(onFailureDlq),
            retryAttempts: props.asyncRetryAttempts ?? 2,
            maxEventAge: props.asyncMaxEventAge ?? cdk.Duration.hours(6),
        });
        onFailureDlqAlarm = (0, failure_handling_1.depthAlarm)(scope, `${id}OnFailureDlqDepthAlarm`, onFailureDlq, onFailureQueueName, `${name}: an asynchronous invocation failed after its retries (the handler raised, or the event ` +
            `aged out). The invocation record, with the event and the error, is waiting in ` +
            `${onFailureQueueName}. Read it, fix the cause, then replay or purge.`, alert);
    }
    let missedRun;
    if (props.missedRunAfter) {
        if (!enabled) {
            cdk.Annotations.of(scope).addInfo(`regelSchedule(${id}): the schedule is disabled, so the missed-run alarm is not created. ` +
                'It appears on the deploy that enables the schedule.');
        }
        else {
            missedRun = (0, failure_handling_1.missedRunAlarm)(scope, `${id}MissedRunAlarm`, name, props.fn, props.missedRunAfter, `${name}: the function has not been invoked for ${props.missedRunAfter.toHumanString()}. The schedule ` +
                'is disabled, Scheduler is not delivering, or the schedule changed. Nothing errors in this ' +
                'state, so this alarm is the only signal. It flips to ALARM once right after the first ' +
                'deploy, until the first run.', alert);
        }
    }
    return { schedule, role, dlq, dlqAlarm, onFailureDlq, onFailureDlqAlarm, missedRunAlarm: missedRun };
}
