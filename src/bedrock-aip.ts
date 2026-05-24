import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { REGEL_CORE_ACCOUNT, REGEL_CORE_REGION } from './account';

/**
 * System-defined inference profile IDs we wrap with Application Inference
 * Profiles. Add new entries as REGEL adopts new models. The ID is what AWS
 * names the cross-region profile in `bedrock list-inference-profiles
 * --type-equals SYSTEM_DEFINED`.
 */
export const REGEL_BEDROCK_MODELS = {
  CLAUDE_SONNET_4_6: 'us.anthropic.claude-sonnet-4-6',
  CLAUDE_OPUS_4_7: 'us.anthropic.claude-opus-4-7',
  CLAUDE_HAIKU_4_5: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  NOVA_MICRO: 'us.amazon.nova-micro-v1:0',
} as const;

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
export class RegelAppInferenceProfile extends Construct {
  readonly profileArn: string;
  readonly profileName: string;
  readonly modelId: RegelBedrockModelId;

  constructor(scope: Construct, id: string, props: RegelAppInferenceProfileProps) {
    super(scope, id);

    const modelShort = shortenModelId(props.modelId);
    const profileName = `${props.appSlug}-${modelShort}`;
    this.profileName = profileName;
    this.modelId = props.modelId;

    const sourceArn =
      `arn:aws:bedrock:${REGEL_CORE_REGION}:${REGEL_CORE_ACCOUNT}:` +
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

/**
 * Convenience: returns IAM resource ARNs the runtime needs to invoke an AIP.
 * Bedrock authorizes BOTH the AIP ARN and the underlying foundation-model /
 * system inference-profile ARN, so the policy must include both.
 */
export function bedrockInvokeResources(
  aips: RegelAppInferenceProfile[],
): string[] {
  const resources = new Set<string>();
  for (const aip of aips) {
    resources.add(aip.profileArn);
    resources.add(
      `arn:aws:bedrock:${REGEL_CORE_REGION}:${REGEL_CORE_ACCOUNT}:` +
        `inference-profile/${aip.modelId}`,
    );
    // foundation-model ARNs are region-less in policies (`*`); collapse with
    // a single anthropic / amazon wildcard depending on family.
    if (aip.modelId.includes('anthropic.claude')) {
      resources.add('arn:aws:bedrock:*::foundation-model/anthropic.claude*');
    } else if (aip.modelId.includes('amazon.nova')) {
      resources.add('arn:aws:bedrock:*::foundation-model/amazon.nova*');
    } else if (aip.modelId.includes('amazon.titan')) {
      resources.add('arn:aws:bedrock:*::foundation-model/amazon.titan*');
    }
  }
  return Array.from(resources);
}

function shortenModelId(modelId: string): string {
  // us.anthropic.claude-sonnet-4-6 → claude-sonnet-4-6
  // us.anthropic.claude-haiku-4-5-20251001-v1:0 → claude-haiku-4-5
  // us.amazon.nova-micro-v1:0 → nova-micro
  const stripped = modelId
    .replace(/^us\./, '')
    .replace(/^global\./, '')
    .replace(/^anthropic\./, '')
    .replace(/^amazon\./, '');
  // Drop `-YYYYMMDD-vN:0` suffix on Anthropic dated models
  const undated = stripped.replace(/-\d{8}-v\d+:\d+$/, '');
  // Drop `-vN:N` plain version suffix on Amazon models
  return undated.replace(/-v\d+:\d+$/, '');
}

// Cheap unit-style smoke for the slug helper so we notice if AWS introduces
// a new model-ID shape that breaks the SSM path.
/** @internal */
export const _shortenModelIdForTest = shortenModelId;
