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
exports.applyRegelCoreTags = applyRegelCoreTags;
exports.applyClawTags = applyClawTags;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const boundary_1 = require("./boundary");
/**
 * CDK Aspect that attaches the REGEL Core permissions boundary to every IAM Role
 * created in the stack. Satisfies the boundary's `iam:CreateRole` allow condition,
 * so CDK-created service roles (Flow Logs, Lambda custom resources, etc.) can be created.
 *
 * Tags are applied via `Tags.of()` directly (not an Aspect) to avoid the CDK
 * invokeAspectsV2 infinite-loop detection triggered by modifying the aspect tree
 * mid-traversal.
 */
class RegelCoreBoundaryAspect {
    visit(node) {
        if (node instanceof iam.CfnRole) {
            node.permissionsBoundary = boundary_1.REGEL_CORE_BOUNDARY_ARN;
            return;
        }
        if (node instanceof aws_cdk_lib_1.CfnResource && node.cfnResourceType === 'AWS::IAM::Role') {
            node.addPropertyOverride('PermissionsBoundary', boundary_1.REGEL_CORE_BOUNDARY_ARN);
        }
    }
}
/**
 * Apply required REGEL Core tags AND the permissions boundary to a construct.
 * Call this once per stack — CDK propagates tags to all child resources automatically.
 *
 * Usage:
 *   applyRegelCoreTags(this, { project: 'shared', environment: 'production', owner: 'shared' });
 */
function applyRegelCoreTags(scope, props) {
    aws_cdk_lib_1.Tags.of(scope).add('Account', props.accountTagValue ?? 'regel-core');
    aws_cdk_lib_1.Tags.of(scope).add('ManagedBy', 'cdk');
    aws_cdk_lib_1.Tags.of(scope).add('Project', props.project);
    aws_cdk_lib_1.Tags.of(scope).add('Environment', props.environment);
    aws_cdk_lib_1.Tags.of(scope).add('Owner', props.owner);
    aws_cdk_lib_1.Tags.of(scope).add('CostCenter', props.costCenter ?? 'ai-platform');
    aws_cdk_lib_1.Aspects.of(scope).add(new RegelCoreBoundaryAspect());
}
/**
 * @deprecated Use `applyRegelCoreTags`. Matches legacy behavior: `Account` tag value is `claw`.
 * Retained for the rename overlap; drop in v2.
 */
function applyClawTags(scope, props) {
    applyRegelCoreTags(scope, { ...props, accountTagValue: props.accountTagValue ?? 'claw' });
}
