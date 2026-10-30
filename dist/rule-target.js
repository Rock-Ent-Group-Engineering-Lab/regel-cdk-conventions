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
exports.regelRuleTarget = regelRuleTarget;
const cdk = __importStar(require("aws-cdk-lib"));
const cloudwatch = __importStar(require("aws-cdk-lib/aws-cloudwatch"));
const cwactions = __importStar(require("aws-cdk-lib/aws-cloudwatch-actions"));
const targets = __importStar(require("aws-cdk-lib/aws-events-targets"));
const destinations = __importStar(require("aws-cdk-lib/aws-lambda-destinations"));
const sns = __importStar(require("aws-cdk-lib/aws-sns"));
const sqs = __importStar(require("aws-cdk-lib/aws-sqs"));
const ALERTS_TOPIC_NAME = 'regel-core-pipeline-alerts';
const FIVE_MINUTES = cdk.Duration.minutes(5);
/** `<name>-onfailure-dlq` must fit SQS's 80 character queue name limit. */
const MAX_NAME_LENGTH = 66;
const MAX_MISSED_RUN_SECONDS = 6 * 24 * 60 * 60;
function regelRuleTarget(scope, id, props) {
    const { name } = props;
    if (cdk.Token.isUnresolved(name)) {
        throw new Error(`regelRuleTarget(${id}): name must be a literal string, not a token. A queue named from ` +
            '`fn.functionName` makes the queue depend on the function and the function\'s role policy ' +
            'depend on the queue, a cycle CloudFormation rejects at deploy. Pass the same literal you ' +
            'gave the function\'s functionName.');
    }
    if (!/^[A-Za-z0-9_-]+$/.test(name) || name.length > MAX_NAME_LENGTH) {
        throw new Error(`regelRuleTarget(${id}): name "${name}" must be letters, digits, "-" or "_", at most ` +
            `${MAX_NAME_LENGTH} characters (the queue "<name>-onfailure-dlq" has to fit SQS's 80).`);
    }
    const stack = cdk.Stack.of(scope);
    if (cdk.Stack.of(props.rule) !== stack || cdk.Stack.of(props.fn) !== stack) {
        throw new Error(`regelRuleTarget(${id}): the rule, the function and the scope must be in the same stack ` +
            '(the queue policy and the failure grant would otherwise cross stacks and cycle).');
    }
    const missedRunAfter = props.missedRunAfter;
    if (missedRunAfter) {
        const seconds = missedRunAfter.toSeconds();
        if (seconds < 60 || seconds % 60 !== 0 || seconds > MAX_MISSED_RUN_SECONDS) {
            throw new Error(`regelRuleTarget(${id}): missedRunAfter must be whole minutes between 1 minute and 6 days ` +
                '(an Invocations alarm cannot look back 7 days, so a weekly rule needs a freshness metric).');
        }
    }
    const alertsTopic = props.alertsTopic ?? sns.Topic.fromTopicArn(scope, `${id}AlertsTopic`, `arn:aws:sns:${stack.region}:${stack.account}:${ALERTS_TOPIC_NAME}`);
    if (alertsTopic.masterKey) {
        throw new Error(`regelRuleTarget(${id}): the alerts topic is KMS-encrypted. CloudWatch and EventBridge cannot ` +
            `publish to a topic whose key policy does not admit them, so every alarm action fails without ` +
            `a sound. Use ${ALERTS_TOPIC_NAME} or an unencrypted topic (alert messages carry no customer data).`);
    }
    const alert = new cwactions.SnsAction(alertsTopic);
    const ruleQueueName = `${name}-eb-dlq`;
    const onFailureQueueName = `${name}-onfailure-dlq`;
    const failureQueue = (queueId, queueName) => new sqs.Queue(scope, queueId, {
        queueName,
        retentionPeriod: cdk.Duration.days(14),
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
    });
    const depthAlarm = (alarmId, queue, queueName, description) => {
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
    };
    const ruleDlq = failureQueue(`${id}EbDlq`, ruleQueueName);
    const onFailureDlq = failureQueue(`${id}OnFailureDlq`, onFailureQueueName);
    // addTarget binds the target, which adds the queue policy that admits
    // events.amazonaws.com with aws:SourceArn pinned to this rule.
    props.rule.addTarget(new targets.LambdaFunction(props.fn, {
        event: props.event,
        deadLetterQueue: ruleDlq,
        retryAttempts: props.retryAttempts ?? 2,
        maxEventAge: props.maxEventAge ?? cdk.Duration.hours(2),
    }));
    props.fn.configureAsyncInvoke({
        onFailure: new destinations.SqsDestination(onFailureDlq),
        retryAttempts: props.asyncRetryAttempts ?? 2,
        maxEventAge: props.asyncMaxEventAge ?? cdk.Duration.hours(6),
    });
    const ruleDlqAlarm = depthAlarm(`${id}EbDlqDepthAlarm`, ruleDlq, ruleQueueName, `${name}: EventBridge could not deliver an event to the function (throttled, permission, or ` +
        `function missing). The event is waiting in ${ruleQueueName}; read it, fix the cause, then ` +
        `redrive or purge. Errors the handler raises do not land here, see ${onFailureQueueName}.`);
    const onFailureDlqAlarm = depthAlarm(`${id}OnFailureDlqDepthAlarm`, onFailureDlq, onFailureQueueName, `${name}: an asynchronous invocation failed after its retries (the handler raised, or the event ` +
        `aged out). The invocation record, with the event and the error, is waiting in ` +
        `${onFailureQueueName}. Read it, fix the cause, then replay or purge.`);
    let missedRunAlarm;
    if (missedRunAfter) {
        const state = props.rule.node.defaultChild?.state;
        if (state === 'DISABLED') {
            cdk.Annotations.of(scope).addInfo(`regelRuleTarget(${id}): the rule is disabled, so the missed-run alarm is not created. ` +
                'It appears on the deploy that enables the rule.');
        }
        else {
            missedRunAlarm = new cloudwatch.Alarm(scope, `${id}MissedRunAlarm`, {
                alarmName: `${name}-missed-run`,
                alarmDescription: `${name}: the function has not been invoked for ${missedRunAfter.toHumanString()}. The rule ` +
                    'is disabled, EventBridge is not delivering, or the schedule changed. Nothing errors in this ' +
                    'state, so this alarm is the only signal. It flips to ALARM once right after the first ' +
                    'deploy, until the first run.',
                metric: props.fn.metricInvocations({ period: missedRunAfter, statistic: 'Sum' }),
                threshold: 1,
                evaluationPeriods: 1,
                comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
                treatMissingData: cloudwatch.TreatMissingData.BREACHING,
            });
            missedRunAlarm.addAlarmAction(alert);
        }
    }
    return { ruleDlq, ruleDlqAlarm, onFailureDlq, onFailureDlqAlarm, missedRunAlarm };
}
