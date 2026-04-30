# regel-cdk-conventions

Shared CDK conventions package. Consumed as a git-dep by every REGEL CDK repo that deploys to account 859287179937.

## What this package owns

- `REGEL_CORE_ACCOUNT` / `REGEL_CORE_REGION` / `REGEL_CORE_ENV` — account + region constants
- `REGEL_CORE_BOUNDARY_ARN` — the permissions boundary ARN that must be on every IAM role (keeps the name `ClawBoundary`; that's the agent-identity policy and stays)
- `applyRegelCoreTags(scope, props)` — tags a stack + installs the boundary Aspect in one call
- `regelCoreSynthesizer()` — `CliCredentialsStackSynthesizer`, the default everywhere
- `regelCoreBootstrapSynthesizer({ qualifier })` — bootstrap synthesizer for Docker-image-asset stacks (currently only reg-fanreach-pipeline)
- Deprecated aliases (`CLAW_BOUNDARY_ARN`, `applyClawTags`, `ClawTagProps`) for the Claw → regel-core rename overlap period. Dropped in v2.

## AWS profile

Always `regel-admin` (account 859287179937, us-east-2). The synthesizer uses caller credentials — if you run `cdk deploy` without `AWS_PROFILE=regel-admin`, you will either target the wrong account or fail outright.

## Releasing

1. Bump `package.json` `version`.
2. `npm run build` — commits the generated `dist/` (consumers use `main: dist/index.js` and don't run TypeScript). Git-dep consumers won't fetch dev dependencies or run `prepare`.
3. Commit both `src/` changes and the rebuilt `dist/`.
4. Tag: `git tag v1.x.y && git push --tags`.
5. Update consuming repos' `package.json` to the new tag when they're ready to pick it up. Never force-upgrade — each consumer cuts over on its own schedule.

**The `dist/` folder is committed intentionally.** Without it, every consumer would need a build step in CI and dev. Do not gitignore it.

## Versioning strategy

- **v1.x** — keeps legacy `applyClawTags` + `CLAW_BOUNDARY_ARN` aliases with `Account=claw` tag default. Adopted by all 14 pipeline repos during Phase 0a as a no-op refactor.
- **v2.0** — drops deprecated aliases, default `Account` tag becomes `regel-core`. Each repo upgrades to v2 during its Phase 4 per-repo cutover, alongside stack rename.

Don't ship v2 until at least one foundation stack has migrated and validated the new tag value in production.

## What does NOT belong here

This package is **conventions only**. Do not add:
- Actual infrastructure stacks (those live in `regel-aws-infrastructure-primary` or per-service repos)
- Service-specific construct wrappers (those belong in their service repo)
- Secrets Manager paths or SSM lookup helpers (account-codename-scoped; keep out of the shared library so the rename doesn't force a major version bump here)

Keep the surface small. Every export here becomes a breaking-change blast radius.

## Overlap-period contract

During the Claw → regel-core migration (see workspace CLAUDE.md for timeline), BOTH old and new exports resolve to the same boundary ARN and the same tag value behavior as the legacy code. A repo that swaps `import { applyClawTags } from './config/tagging'` for `import { applyClawTags } from 'regel-cdk-conventions'` should produce **zero CloudFormation diff**. If it produces a diff, there's a bug in this package — investigate before shipping.

## See also

- `~/Development/regel/CLAUDE.md` — workspace-level context on the Claw → regel-core rename
- `regel-aws-infrastructure-primary/CLAUDE.md` — foundation stacks repo (the primary consumer of this package)
