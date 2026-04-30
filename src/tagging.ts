import { Aspects, CfnResource, IAspect, Tags } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { IConstruct } from 'constructs';
import { REGEL_CORE_BOUNDARY_ARN } from './boundary';

/**
 * CDK Aspect that attaches the REGEL Core permissions boundary to every IAM Role
 * created in the stack. Satisfies the boundary's `iam:CreateRole` allow condition,
 * so CDK-created service roles (Flow Logs, Lambda custom resources, etc.) can be created.
 *
 * Tags are applied via `Tags.of()` directly (not an Aspect) to avoid the CDK
 * invokeAspectsV2 infinite-loop detection triggered by modifying the aspect tree
 * mid-traversal.
 */
class RegelCoreBoundaryAspect implements IAspect {
  visit(node: IConstruct): void {
    if (node instanceof iam.CfnRole) {
      node.permissionsBoundary = REGEL_CORE_BOUNDARY_ARN;
      return;
    }
    if (node instanceof CfnResource && node.cfnResourceType === 'AWS::IAM::Role') {
      node.addPropertyOverride('PermissionsBoundary', REGEL_CORE_BOUNDARY_ARN);
    }
  }
}

export interface RegelCoreTagProps {
  project: string;
  environment: 'production' | 'development' | 'staging';
  owner: string;
  costCenter?: string;
  /**
   * Overrides the `Account` tag value. Defaults to `regel-core`.
   * During the Claw → regel-core migration, `applyClawTags` passes `'claw'` here
   * so existing stacks keep their legacy tag value until they're renamed.
   */
  accountTagValue?: string;
}

/**
 * Apply required REGEL Core tags AND the permissions boundary to a construct.
 * Call this once per stack — CDK propagates tags to all child resources automatically.
 *
 * Usage:
 *   applyRegelCoreTags(this, { project: 'shared', environment: 'production', owner: 'shared' });
 */
export function applyRegelCoreTags(scope: IConstruct, props: RegelCoreTagProps): void {
  Tags.of(scope).add('Account', props.accountTagValue ?? 'regel-core');
  Tags.of(scope).add('ManagedBy', 'cdk');
  Tags.of(scope).add('Project', props.project);
  Tags.of(scope).add('Environment', props.environment);
  Tags.of(scope).add('Owner', props.owner);
  Tags.of(scope).add('CostCenter', props.costCenter ?? 'ai-platform');

  Aspects.of(scope).add(new RegelCoreBoundaryAspect());
}

/** @deprecated kept so v1 consumers can migrate by swapping the import without behavior change. */
export type ClawTagProps = RegelCoreTagProps;

/**
 * @deprecated Use `applyRegelCoreTags`. Matches legacy behavior: `Account` tag value is `claw`.
 * Retained for the rename overlap; drop in v2.
 */
export function applyClawTags(scope: IConstruct, props: ClawTagProps): void {
  applyRegelCoreTags(scope, { ...props, accountTagValue: props.accountTagValue ?? 'claw' });
}
