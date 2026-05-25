import { Construct } from 'constructs';
/**
 * System-defined inference profile IDs we wrap with Application Inference
 * Profiles. Add new entries as REGEL adopts new models. The ID is what AWS
 * names the cross-region profile in `bedrock list-inference-profiles
 * --type-equals SYSTEM_DEFINED`.
 */
export declare const REGEL_BEDROCK_MODELS: {
    readonly CLAUDE_SONNET_4_6: "us.anthropic.claude-sonnet-4-6";
    readonly CLAUDE_OPUS_4_7: "us.anthropic.claude-opus-4-7";
    readonly CLAUDE_HAIKU_4_5: "us.anthropic.claude-haiku-4-5-20251001-v1:0";
    readonly CLAUDE_SONNET_4_6_GLOBAL: "global.anthropic.claude-sonnet-4-6";
    readonly CLAUDE_OPUS_4_7_GLOBAL: "global.anthropic.claude-opus-4-7";
    readonly CLAUDE_HAIKU_4_5_GLOBAL: "global.anthropic.claude-haiku-4-5-20251001-v1:0";
    readonly NOVA_MICRO: "us.amazon.nova-micro-v1:0";
};
export type RegelBedrockModelId = typeof REGEL_BEDROCK_MODELS[keyof typeof REGEL_BEDROCK_MODELS];
export interface RegelAppInferenceProfileProps {
    /** Short app slug used in the AIP name and SSM path. e.g. `quarry`, `penny`. */
    readonly appSlug: string;
    /** Which model to wrap. Use `REGEL_BEDROCK_MODELS.*`. */
    readonly modelId: RegelBedrockModelId;
    /** Free-form description shown in the Bedrock console. */
    readonly description?: string;
    /**
     * If true (default), publish the AIP ARN as
     *   /regel-core/<appSlug>/bedrock-aip/<modelShortName>
     * so the runtime can read it via SSM at startup instead of being hardcoded.
     */
    readonly publishSsm?: boolean;
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
export declare class RegelAppInferenceProfile extends Construct {
    readonly profileArn: string;
    readonly profileName: string;
    readonly modelId: RegelBedrockModelId;
    constructor(scope: Construct, id: string, props: RegelAppInferenceProfileProps);
}
/**
 * Convenience: returns IAM resource ARNs the runtime needs to invoke an AIP.
 * Bedrock authorizes BOTH the AIP ARN and the underlying foundation-model /
 * system inference-profile ARN, so the policy must include both.
 */
export declare function bedrockInvokeResources(aips: RegelAppInferenceProfile[]): string[];
declare function shortenModelId(modelId: string): string;
/** @internal */
export declare const _shortenModelIdForTest: typeof shortenModelId;
export {};
