import * as cdk from 'aws-cdk-lib';
/**
 * The ONLY synthesizer you should be using in REGEL.
 *
 * Returns `CliCredentialsStackSynthesizer` — CDK deploys directly with the
 * caller's CLI credentials (expected: `AWS_PROFILE=regel-admin`). No CDK
 * bootstrap stack is involved.
 *
 * REGEL deliberately does not use `cdk bootstrap` in the regel-core account.
 * See `regel-aws-infrastructure-primary/CLAUDE.md` for the full rationale;
 * short version:
 *
 *   1. `ClawBoundary` (the agent-identity permissions boundary applied to
 *      every role in the account) blocks CDK's bootstrap from creating
 *      unconstrained CFN exec / asset-publishing roles.
 *   2. An organization-level SCP additionally denies IAM actions from a
 *      CFN exec role that lacks `ClawBoundary`.
 *   3. Together these guarantee that `cdk bootstrap` produces a broken
 *      toolkit stack and subsequent deploys fail in `ROLLBACK_FAILED`
 *      with orphan roles that CloudFormation can't clean up.
 *
 * Docker image assets work fine under `CliCredentialsStackSynthesizer` — the
 * caller's `regel-admin` credentials are used for asset publishing, and
 * images land in the caller-resolved ECR/S3. Bootstrap is not required.
 *
 * If you think you need bootstrap, you are wrong. Read the shared CLAUDE.md.
 */
export declare function regelCoreSynthesizer(): cdk.IStackSynthesizer;
/**
 * @deprecated REGEL does not bootstrap. Use `regelCoreSynthesizer()`.
 *
 * This helper exists only to keep `reg-fanreach-pipeline`'s historical
 * bootstrap working during Phase 4 cutover. Once that repo migrates off
 * bootstrap it will be removed. **Never call from a new stack.** If a new
 * stack is tempted to use this because it has Docker image assets — it
 * doesn't need to; image assets work under `regelCoreSynthesizer()` too.
 *
 * See `regel-aws-infrastructure-primary/CLAUDE.md` and the feedback memory
 * "REGEL doesn't bootstrap CDK" for why bootstrap is actively harmful here.
 */
export interface BootstrapSynthesizerOptions {
    /** CDK bootstrap qualifier. Defaults to `regelcore`. */
    qualifier?: string;
}
/** @deprecated See `regelCoreSynthesizer()`. Do not use in new stacks. */
export declare function regelCoreBootstrapSynthesizer(opts?: BootstrapSynthesizerOptions): cdk.IStackSynthesizer;
