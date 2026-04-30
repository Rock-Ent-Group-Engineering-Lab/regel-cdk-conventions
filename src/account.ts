/**
 * Account + region constants for the shared REGEL AWS environment.
 *
 * Use `regel-admin` as the AWS profile for any CLI or SDK call against this account.
 */

export const REGEL_CORE_ACCOUNT = '859287179937';
export const REGEL_CORE_REGION = 'us-east-2';
export const REGEL_CORE_PROFILE = 'regel-admin';

export const REGEL_CORE_ENV = {
  account: REGEL_CORE_ACCOUNT,
  region: REGEL_CORE_REGION,
} as const;
