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
const targets = __importStar(require("aws-cdk-lib/aws-events-targets"));
const destinations = __importStar(require("aws-cdk-lib/aws-lambda-destinations"));
const failure_handling_1 = require("./failure-handling");
/** `<name>-onfailure-dlq` must fit SQS's 80 character queue name limit. */
const MAX_NAME_LENGTH = 66;
function regelRuleTarget(scope, id, props) {
    const { name } = props;
    (0, failure_handling_1.checkLiteralName)('regelRuleTarget', id, name, MAX_NAME_LENGTH, 'the queue "<name>-onfailure-dlq" has to fit SQS\'s 80');
    const stack = cdk.Stack.of(scope);
    if (cdk.Stack.of(props.rule) !== stack || cdk.Stack.of(props.fn) !== stack) {
        throw new Error(`regelRuleTarget(${id}): the rule, the function and the scope must be in the same stack ` +
            '(the queue policy and the failure grant would otherwise cross stacks and cycle).');
    }
    const missedRunAfter = props.missedRunAfter;
    (0, failure_handling_1.checkMissedRunWindow)('regelRuleTarget', id, missedRunAfter, 'rule');
    const alert = (0, failure_handling_1.alertAction)('regelRuleTarget', scope, id, props.alertsTopic);
    const ruleQueueName = `${name}-eb-dlq`;
    const onFailureQueueName = `${name}-onfailure-dlq`;
    const ruleDlq = (0, failure_handling_1.failureQueue)(scope, `${id}EbDlq`, ruleQueueName);
    const onFailureDlq = (0, failure_handling_1.failureQueue)(scope, `${id}OnFailureDlq`, onFailureQueueName);
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
    const ruleDlqAlarm = (0, failure_handling_1.depthAlarm)(scope, `${id}EbDlqDepthAlarm`, ruleDlq, ruleQueueName, `${name}: EventBridge could not deliver an event to the function (throttled, permission, or ` +
        `function missing). The event is waiting in ${ruleQueueName}; read it, fix the cause, then ` +
        `redrive or purge. Errors the handler raises do not land here, see ${onFailureQueueName}.`, alert);
    const onFailureDlqAlarm = (0, failure_handling_1.depthAlarm)(scope, `${id}OnFailureDlqDepthAlarm`, onFailureDlq, onFailureQueueName, `${name}: an asynchronous invocation failed after its retries (the handler raised, or the event ` +
        `aged out). The invocation record, with the event and the error, is waiting in ` +
        `${onFailureQueueName}. Read it, fix the cause, then replay or purge.`, alert);
    let missedRun;
    if (missedRunAfter) {
        const state = props.rule.node.defaultChild?.state;
        if (state === 'DISABLED') {
            cdk.Annotations.of(scope).addInfo(`regelRuleTarget(${id}): the rule is disabled, so the missed-run alarm is not created. ` +
                'It appears on the deploy that enables the rule.');
        }
        else {
            missedRun = (0, failure_handling_1.missedRunAlarm)(scope, `${id}MissedRunAlarm`, name, props.fn, missedRunAfter, `${name}: the function has not been invoked for ${missedRunAfter.toHumanString()}. The rule ` +
                'is disabled, EventBridge is not delivering, or the schedule changed. Nothing errors in this ' +
                'state, so this alarm is the only signal. It flips to ALARM once right after the first ' +
                'deploy, until the first run.', alert);
        }
    }
    return { ruleDlq, ruleDlqAlarm, onFailureDlq, onFailureDlqAlarm, missedRunAlarm: missedRun };
}
