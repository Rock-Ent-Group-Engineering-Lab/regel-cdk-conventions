# regel-cdk-conventions

Shared CDK conventions for REGEL AWS stacks: account constants, tagging helper, permissions boundary, synthesizer factories.

Consumed by every CDK repo in `Rock-Ent-Group-Engineering-Lab` that deploys to the REGEL Core account (859287179937, us-east-2). Pulled in as a git-dep.

## Install

In the consuming repo's `infra/package.json`:

```json
{
  "dependencies": {
    "regel-cdk-conventions": "github:Rock-Ent-Group-Engineering-Lab/regel-cdk-conventions#v1.0.0"
  }
}
```

Always pin to a tag (`#v1.0.0`). Never consume from `main` — the overlap-period deprecated aliases are slated for removal in v2.

## Use

```typescript
import {
  REGEL_CORE_ENV,
  applyRegelCoreTags,
  regelCoreSynthesizer,
} from 'regel-cdk-conventions';
import * as cdk from 'aws-cdk-lib';

const app = new cdk.App();

const stack = new MyStack(app, 'MyStack', {
  env: REGEL_CORE_ENV,
  synthesizer: regelCoreSynthesizer(),
});

applyRegelCoreTags(stack, {
  project: 'my-project',
  environment: 'production',
  owner: 'conor',
});
```

`applyRegelCoreTags` tags the stack AND installs a CDK Aspect that attaches the permissions boundary to every IAM role created in the stack. Call it exactly once per stack.

## Deploy

From the consuming repo's infrastructure directory, use its documented deploy
script or installed CDK binary with `AWS_PROFILE=regel-admin`:

```bash
AWS_PROFILE=regel-admin ./node_modules/.bin/cdk deploy
```

The synthesizer uses `CliCredentialsStackSynthesizer`, so it inherits whichever profile is active. If you deploy without `regel-admin`, it will target the wrong account or fail.

## Docker image assets

Use `regelCoreSynthesizer()` for Docker image assets too, including
`DockerImageAsset` and `ecs.ContainerImage.fromAsset`. Its
`CliCredentialsStackSynthesizer` publishes assets with the caller's credentials;
Docker assets do not require switching synthesizers.

**Do not run `cdk bootstrap` in REGEL Core.** The permissions boundary and
organization SCPs are incompatible with the standard bootstrap-role path.
`regelCoreBootstrapSynthesizer()` is a deprecated compatibility export for
historical callers, not a setup step for new stacks.

The operating contract is in [CLAUDE.md](CLAUDE.md#what-this-package-owns);
the factory and compatibility notes live in
[src/synthesizer.ts](src/synthesizer.ts).

## Migration path from legacy `tagging.ts`

Every pipeline repo historically had its own copy of `infra/lib/config/tagging.ts` exporting `CLAW_BOUNDARY_ARN` and `applyClawTags`. Migration:

1. Add this package as a git-dep at a pinned tag.
2. Delete the local `infra/lib/config/tagging.ts`.
3. Replace imports:
   ```typescript
   // Before:
   import { applyClawTags } from './config/tagging';

   // After (v1, overlap period):
   import { applyClawTags } from 'regel-cdk-conventions';
   ```
4. `cdk diff` should show no CloudFormation change — boundary ARN and tag values are identical.

Once a repo cuts over to the new `regel-core-*` naming, swap to:

```typescript
import { applyRegelCoreTags } from 'regel-cdk-conventions';
```

The `Account` tag flips from `claw` to `regel-core` at that point. That IS a diff, intended.

## Versioning

- **v1.x** — overlap period. Exports both `applyRegelCoreTags` and `applyClawTags`, plus `REGEL_CORE_BOUNDARY_ARN` and `CLAW_BOUNDARY_ARN` aliases. Used while repos migrate.
- **v2.x** — post-rename. Drops deprecated aliases. Default `Account` tag becomes `regel-core`.

Tag cuts go via GitHub releases. Bump major when tag values change or deprecated exports are dropped.
