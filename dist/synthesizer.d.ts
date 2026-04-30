import * as cdk from 'aws-cdk-lib';
/**
 * Default synthesizer for REGEL Core stacks.
 *
 * Uses `CliCredentialsStackSynthesizer` — deploys directly with the caller's CLI
 * credentials (expected: `AWS_PROFILE=regel-admin`). No CDK bootstrap roles, which
 * avoids the `ClawBoundary` guardrail that blocks `iam:CreateRole` on unconstrained
 * CDK-managed roles.
 *
 * Use this for every stack unless the stack uses Docker image assets
 * (`DockerImageAsset` / `ecs.ContainerImage.fromAsset`), which require bootstrap.
 * For those, use `regelCoreBootstrapSynthesizer()`.
 */
export declare function regelCoreSynthesizer(): cdk.IStackSynthesizer;
export interface BootstrapSynthesizerOptions {
    /** CDK bootstrap qualifier. Defaults to `regelcore`. */
    qualifier?: string;
}
/**
 * Bootstrap-based synthesizer for REGEL Core stacks that publish Docker image assets.
 *
 * Requires the account to be bootstrapped under the chosen qualifier:
 *   AWS_PROFILE=regel-admin cdk bootstrap --qualifier regelcore aws://859287179937/us-east-2
 *
 * The bootstrap stack's CFN exec role must have `ClawBoundary` set as its permissions
 * boundary (pass `--custom-permissions-boundary ClawBoundary` at bootstrap time).
 */
export declare function regelCoreBootstrapSynthesizer(opts?: BootstrapSynthesizerOptions): cdk.IStackSynthesizer;
