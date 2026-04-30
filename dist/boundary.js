"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CLAW_BOUNDARY_ARN = exports.REGEL_CORE_BOUNDARY_ARN = void 0;
const account_1 = require("./account");
/**
 * Permissions boundary ARN required on every IAM role created in the REGEL Core account.
 *
 * The policy NAME intentionally stays "ClawBoundary" — it applies to the Open Claw agent
 * identity (the IAM user whose credentials power `regel-admin`), not to the account codename.
 * The boundary constrains what agentic code can create and prevents privilege escalation.
 * Renaming it would require atomic updates across 80+ boundary attachments, with no benefit.
 *
 * Attached automatically by `applyRegelCoreTags()` via a CDK Aspect.
 */
exports.REGEL_CORE_BOUNDARY_ARN = `arn:aws:iam::${account_1.REGEL_CORE_ACCOUNT}:policy/ClawBoundary`;
/**
 * @deprecated Use `REGEL_CORE_BOUNDARY_ARN` — identical value, clearer name.
 * Retained for the Claw → regel-core rename overlap period; drop in v2.
 */
exports.CLAW_BOUNDARY_ARN = exports.REGEL_CORE_BOUNDARY_ARN;
