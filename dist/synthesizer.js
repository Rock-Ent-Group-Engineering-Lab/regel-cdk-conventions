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
exports.regelCoreSynthesizer = regelCoreSynthesizer;
exports.regelCoreBootstrapSynthesizer = regelCoreBootstrapSynthesizer;
const cdk = __importStar(require("aws-cdk-lib"));
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
function regelCoreSynthesizer() {
    return new cdk.CliCredentialsStackSynthesizer();
}
/** @deprecated See `regelCoreSynthesizer()`. Do not use in new stacks. */
function regelCoreBootstrapSynthesizer(opts = {}) {
    // eslint-disable-next-line no-console
    console.warn('[regel-cdk-conventions] regelCoreBootstrapSynthesizer() is deprecated; ' +
        'REGEL deploys without CDK bootstrap. Use regelCoreSynthesizer() instead. ' +
        'See regel-aws-infrastructure-primary/CLAUDE.md.');
    const qualifier = opts.qualifier ?? 'regelcore';
    return new cdk.DefaultStackSynthesizer({ qualifier });
}
