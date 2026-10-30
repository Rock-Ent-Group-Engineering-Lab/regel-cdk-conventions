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
exports._shortenModelIdForTest = exports.RegelAppInferenceProfile = exports.FOUNDATION_MODEL_IDS = exports.REGEL_BEDROCK_MODELS = void 0;
exports.bedrockInvokeResources = bedrockInvokeResources;
const bedrock = __importStar(require("aws-cdk-lib/aws-bedrock"));
const ssm = __importStar(require("aws-cdk-lib/aws-ssm"));
const constructs_1 = require("constructs");
const account_1 = require("./account");
/**
 * System-defined inference profile IDs we wrap with Application Inference
 * Profiles. Add new entries as REGEL adopts new models. The ID is what AWS
 * names the cross-region profile in `bedrock list-inference-profiles
 * --type-equals SYSTEM_DEFINED`.
 */
exports.REGEL_BEDROCK_MODELS = {
    CLAUDE_SONNET_5: 'us.anthropic.claude-sonnet-5',
    CLAUDE_SONNET_4_6: 'us.anthropic.claude-sonnet-4-6',
    CLAUDE_OPUS_4_7: 'us.anthropic.claude-opus-4-7',
    CLAUDE_SONNET_5_5: 'us.anthropic.claude-sonnet-5-5',
    CLAUDE_OPUS_5_5: 'us.anthropic.claude-opus-5-5',
    CLAUDE_HAIKU_5_5: 'us.anthropic.claude-haiku-5-5',
    CLAUDE_HAIKU_4_5: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    CLAUDE_SONNET_5_GLOBAL: 'global.anthropic.claude-sonnet-5',
    CLAUDE_SONNET_5_5_GLOBAL: 'global.anthropic.claude-sonnet-5-5',
    CLAUDE_SONNET_4_6_GLOBAL: 'global.anthropic.claude-sonnet-4-6',
    CLAUDE_OPUS_4_7_GLOBAL: 'global.anthropic.claude-opus-4-7',
    CLAUDE_OPUS_5_5_GLOBAL: 'global.anthropic.claude-opus-5-5',
    CLAUDE_HAIKU_4_5_GLOBAL: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    CLAUDE_HAIKU_5_5_GLOBAL: 'global.anthropic.claude-haiku-5-5',
    NOVA_MICRO: 'us.amazon.nova-micro-v1:0',
    /**
     * Titan Text Embeddings V2. A foundation model with no system inference
     * profile, so its AIP copies from the foundation-model ARN (see
     * FOUNDATION_MODEL_IDS) and invokes in us-east-2 only.
     */
    TITAN_EMBED_V2: 'amazon.titan-embed-text-v2:0',
};
/**
 * Models that have no system inference profile. Their AIP copies from the
 * regional foundation-model ARN instead of an `inference-profile/` ARN.
 */
exports.FOUNDATION_MODEL_IDS = [exports.REGEL_BEDROCK_MODELS.TITAN_EMBED_V2];
function isFoundationModel(modelId) {
    return exports.FOUNDATION_MODEL_IDS.includes(modelId);
}
/**
 * Wraps an AWS-managed cross-region inference profile (e.g.
 * `us.anthropic.claude-sonnet-4-6`) as an Application Inference Profile so
 * Bedrock invocations carry stack-level cost-allocation tags and show up
 * per-app in Cost Explorer.
 *
 * Usage:
 *   const aip = new RegelAppInferenceProfile(this, 'QuarrySonnet', {
 *     appSlug: 'quarry',
 *     modelId: REGEL_BEDROCK_MODELS.CLAUDE_SONNET_4_6,
 *   });
 *   // grant InvokeModel on aip.profileArn to the runtime role
 *
 * The shared `applyRegelCoreTags` aspect on the parent stack propagates the
 * six standard tags onto the underlying CfnApplicationInferenceProfile, so
 * Cost Explorer can group Bedrock spend by `Project` / `Owner` / `CostCenter`.
 */
class RegelAppInferenceProfile extends constructs_1.Construct {
    constructor(scope, id, props) {
        super(scope, id);
        const modelShort = shortenModelId(props.modelId);
        const profileName = `${props.appSlug}-${modelShort}`;
        this.profileName = profileName;
        this.modelId = props.modelId;
        const sourceArn = isFoundationModel(props.modelId)
            ? `arn:aws:bedrock:${account_1.REGEL_CORE_REGION}::foundation-model/${props.modelId}`
            : `arn:aws:bedrock:${account_1.REGEL_CORE_REGION}:${account_1.REGEL_CORE_ACCOUNT}:` +
                `inference-profile/${props.modelId}`;
        // Bedrock AIP description regex `^([0-9a-zA-Z:.][ _-]?)+$` allows alnum,
        // colon, dot, and at most one space/underscore/hyphen between alnums.
        // No arrows, em-dashes, slashes, or runs of separators.
        const cfn = new bedrock.CfnApplicationInferenceProfile(this, 'Profile', {
            inferenceProfileName: profileName,
            description: props.description ?? `${props.appSlug}-${props.modelId}`,
            modelSource: {
                copyFrom: sourceArn,
            },
        });
        this.profileArn = cfn.attrInferenceProfileArn;
        if (props.publishSsm !== false) {
            new ssm.StringParameter(this, 'ArnParam', {
                parameterName: `/regel-core/${props.appSlug}/bedrock-aip/${modelShort}`,
                stringValue: this.profileArn,
                description: `Bedrock AIP ARN for ${props.appSlug} → ${props.modelId}`,
            });
        }
    }
}
exports.RegelAppInferenceProfile = RegelAppInferenceProfile;
/**
 * Convenience: returns IAM resource ARNs the runtime needs to invoke an AIP.
 * Bedrock authorizes BOTH the AIP ARN and the underlying foundation-model /
 * system inference-profile ARN, so the policy must include both.
 */
function bedrockInvokeResources(aips) {
    const resources = new Set();
    for (const aip of aips) {
        resources.add(aip.profileArn);
        if (isFoundationModel(aip.modelId)) {
            // No system profile to authorize: the AIP copies this one regional
            // foundation model, and that is all the role needs besides the AIP.
            resources.add(`arn:aws:bedrock:${account_1.REGEL_CORE_REGION}::foundation-model/${aip.modelId}`);
            continue;
        }
        resources.add(`arn:aws:bedrock:${account_1.REGEL_CORE_REGION}:${account_1.REGEL_CORE_ACCOUNT}:` +
            `inference-profile/${aip.modelId}`);
        // foundation-model ARNs are region-less in policies (`*`); collapse with
        // a single anthropic / amazon wildcard depending on family.
        if (aip.modelId.includes('anthropic.claude')) {
            resources.add('arn:aws:bedrock:*::foundation-model/anthropic.claude*');
        }
        else if (aip.modelId.includes('amazon.nova')) {
            resources.add('arn:aws:bedrock:*::foundation-model/amazon.nova*');
        }
    }
    return Array.from(resources);
}
function shortenModelId(modelId) {
    // us.anthropic.claude-sonnet-4-6              → claude-sonnet-4-6
    // us.anthropic.claude-opus-5-5                → claude-opus-5-5
    // global.anthropic.claude-sonnet-4-6          → claude-sonnet-4-6-global
    // us.anthropic.claude-haiku-4-5-20251001-v1:0 → claude-haiku-4-5
    // global.anthropic.claude-haiku-4-5-20251001-v1:0 → claude-haiku-4-5-global
    // us.amazon.nova-micro-v1:0                   → nova-micro
    // amazon.titan-embed-text-v2:0                → titan-embed-text-v2
    if (modelId.startsWith('amazon.titan')) {
        return modelId.replace(/^amazon\./, '').replace(/:\d+$/, '');
    }
    const isGlobal = modelId.startsWith('global.');
    const stripped = modelId
        .replace(/^us\./, '')
        .replace(/^global\./, '')
        .replace(/^anthropic\./, '')
        .replace(/^amazon\./, '');
    const undated = stripped.replace(/-\d{8}-v\d+:\d+$/, '');
    const trimmed = undated.replace(/-v\d+:\d+$/, '');
    return isGlobal ? `${trimmed}-global` : trimmed;
}
// Cheap unit-style smoke for the slug helper so we notice if AWS introduces
// a new model-ID shape that breaks the SSM path.
/** @internal */
exports._shortenModelIdForTest = shortenModelId;
