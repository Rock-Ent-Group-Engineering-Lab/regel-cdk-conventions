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
exports.mcpLambdaAlarms = mcpLambdaAlarms;
const cdk = __importStar(require("aws-cdk-lib"));
const cloudwatch = __importStar(require("aws-cdk-lib/aws-cloudwatch"));
const cwactions = __importStar(require("aws-cdk-lib/aws-cloudwatch-actions"));
const FIVE_MINUTES = cdk.Duration.minutes(5);
function mcpLambdaAlarms(scope, props) {
    const ids = {
        errors: 'ServerFnErrorsAlarm',
        stuck: 'ServerFnStuckAlarm',
        dlq: 'ServerDlqDepthAlarm',
        infraFailure: 'InfraFailureAlarm',
        ...(props.ids ?? {}),
    };
    const action = new cwactions.SnsAction(props.alertsTopic);
    const logGroup = props.logGroupName ?? `/aws/lambda/${props.fn.functionName}`;
    const timeoutSeconds = props.timeout.toSeconds();
    const fraction = props.stuckFraction ?? 0.8;
    const stuckMs = Math.round(props.timeout.toMilliseconds() * fraction);
    const errors = new cloudwatch.Alarm(scope, ids.errors, {
        alarmName: `${props.alarmPrefix}-server-errors`,
        alarmDescription: `${props.alarmPrefix}: Lambda Errors in 2 of the last 3 five-minute windows ` +
            `(one transient window does not page). Check ${logGroup}. ` +
            `A ${timeoutSeconds}s REPORT with Status: timeout means a held-open stream, see the stuck alarm.`,
        metric: props.fn.metricErrors({ period: FIVE_MINUTES, statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    errors.addAlarmAction(action);
    const stuck = new cloudwatch.Alarm(scope, ids.stuck, {
        alarmName: `${props.alarmPrefix}-server-stuck`,
        alarmDescription: `${props.alarmPrefix}: p99 Duration >= ${Math.round(fraction * 100)}% of the ` +
            `${timeoutSeconds}s function timeout. An invocation is being held open: an MCP ` +
            `listen/SSE stream (a Lambda cannot host one; REG-620, incident known-failures #9) ` +
            `or a hung backend. Check ${logGroup} for REPORT lines at the timeout.`,
        metric: props.fn.metricDuration({ period: FIVE_MINUTES, statistic: 'p99' }),
        threshold: stuckMs,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    stuck.addAlarmAction(action);
    let dlq;
    if (props.dlq) {
        dlq = new cloudwatch.Alarm(scope, ids.dlq, {
            alarmName: `${props.alarmPrefix}-dlq-not-empty`,
            alarmDescription: `${props.alarmPrefix}: the DLQ has >= 1 message, an invocation failed after retries. ` +
                `Inspect ${props.dlq.queueName}; messages are the replay set, never delete them.`,
            metric: props.dlq.metricApproximateNumberOfMessagesVisible({ period: FIVE_MINUTES, statistic: 'Maximum' }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        dlq.addAlarmAction(action);
    }
    let infraFailure;
    if (props.infraFailureMetric) {
        infraFailure = new cloudwatch.Alarm(scope, ids.infraFailure, {
            alarmName: `${props.alarmPrefix}-infra-failure`,
            alarmDescription: `${props.alarmPrefix}: a tool returned an infrastructure failure to a user ` +
                `(handled, so it never reaches Lambda Errors). Check the audit lines in ${logGroup}.` +
                (props.infraFailureHint ? ` ${props.infraFailureHint}` : ''),
            metric: props.infraFailureMetric,
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        infraFailure.addAlarmAction(action);
    }
    return { errors, stuck, dlq, infraFailure };
}
