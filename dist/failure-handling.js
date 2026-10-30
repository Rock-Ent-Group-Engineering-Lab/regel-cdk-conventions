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
exports.FIVE_MINUTES = exports.ALERTS_TOPIC_NAME = void 0;
exports.checkLiteralName = checkLiteralName;
exports.alertAction = alertAction;
exports.failureQueue = failureQueue;
exports.depthAlarm = depthAlarm;
exports.checkMissedRunWindow = checkMissedRunWindow;
exports.missedRunAlarm = missedRunAlarm;
// Pieces shared by regelRuleTarget (rule-target.ts) and regelSchedule (schedule.ts): the failure
// queue, its depth alarm, the alerts topic guard, the literal-name guard and the missed-run window.
// Internal: not exported from the package index, so the public surface stays small.
const cdk = __importStar(require("aws-cdk-lib"));
const cloudwatch = __importStar(require("aws-cdk-lib/aws-cloudwatch"));
const cwactions = __importStar(require("aws-cdk-lib/aws-cloudwatch-actions"));
const sns = __importStar(require("aws-cdk-lib/aws-sns"));
const sqs = __importStar(require("aws-cdk-lib/aws-sqs"));
exports.ALERTS_TOPIC_NAME = 'regel-core-pipeline-alerts';
exports.FIVE_MINUTES = cdk.Duration.minutes(5);
const MAX_MISSED_RUN_SECONDS = 6 * 24 * 60 * 60;
/** A name that becomes part of queue and alarm names: a literal string, never a token. `max` is the longest
 *  name the longest derived name can carry; `why` says which derived name sets the limit. */
function checkLiteralName(helper, id, name, max, why) {
    if (cdk.Token.isUnresolved(name)) {
        throw new Error(`${helper}(${id}): name must be a literal string, not a token. A queue named from ` +
            '`fn.functionName` makes the queue depend on the function and the function\'s role policy ' +
            'depend on the queue, a cycle CloudFormation rejects at deploy. Pass the same literal you ' +
            'gave the function\'s functionName.');
    }
    if (!/^[A-Za-z0-9_-]+$/.test(name) || name.length > max) {
        throw new Error(`${helper}(${id}): name "${name}" must be letters, digits, "-" or "_", at most ` +
            `${max} characters (${why}).`);
    }
}
/** The alarm action for the alerts topic (default: the shared `regel-core-pipeline-alerts` in this stack's
 *  account and region). A KMS-encrypted topic throws: CloudWatch and EventBridge cannot publish to it. */
function alertAction(helper, scope, id, topic) {
    const stack = cdk.Stack.of(scope);
    const alertsTopic = topic ?? sns.Topic.fromTopicArn(scope, `${id}AlertsTopic`, `arn:aws:sns:${stack.region}:${stack.account}:${exports.ALERTS_TOPIC_NAME}`);
    if (alertsTopic.masterKey) {
        throw new Error(`${helper}(${id}): the alerts topic is KMS-encrypted. CloudWatch and EventBridge cannot ` +
            `publish to a topic whose key policy does not admit them, so every alarm action fails without ` +
            `a sound. Use ${exports.ALERTS_TOPIC_NAME} or an unencrypted topic (alert messages carry no customer data).`);
    }
    return new cwactions.SnsAction(alertsTopic);
}
/** A failure queue: SSE-SQS (never the shared data key, whose policy does not admit the event services),
 *  TLS only, 14 days, a literal name. */
function failureQueue(scope, queueId, queueName) {
    return new sqs.Queue(scope, queueId, {
        queueName,
        retentionPeriod: cdk.Duration.days(14),
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
    });
}
/** >= 1 visible message in one five-minute window, alarm action only. One window on purpose: a message in a
 *  failure queue stays there, so it fires on the first failure of a daily or weekly job. */
function depthAlarm(scope, alarmId, queue, queueName, description, alert) {
    const alarm = new cloudwatch.Alarm(scope, alarmId, {
        alarmName: `${queueName}-not-empty`,
        alarmDescription: description,
        metric: queue.metricApproximateNumberOfMessagesVisible({ period: exports.FIVE_MINUTES, statistic: 'Maximum' }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(alert);
    return alarm;
}
/** `missedRunAfter` is whole minutes, 1 minute to 6 days (an Invocations alarm cannot look back 7 days). */
function checkMissedRunWindow(helper, id, window, what) {
    if (!window)
        return;
    const seconds = window.toSeconds();
    if (seconds < 60 || seconds % 60 !== 0 || seconds > MAX_MISSED_RUN_SECONDS) {
        throw new Error(`${helper}(${id}): missedRunAfter must be whole minutes between 1 minute and 6 days ` +
            `(an Invocations alarm cannot look back 7 days, so a weekly ${what} needs a freshness metric).`);
    }
}
/** `Invocations < 1` over the window, missing data breaches, alarm action only. */
function missedRunAlarm(scope, alarmId, name, fn, window, description, alert) {
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
