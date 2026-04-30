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
function regelCoreSynthesizer() {
    return new cdk.CliCredentialsStackSynthesizer();
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
function regelCoreBootstrapSynthesizer(opts = {}) {
    const qualifier = opts.qualifier ?? 'regelcore';
    return new cdk.DefaultStackSynthesizer({ qualifier });
}
