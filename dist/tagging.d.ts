import { IConstruct } from 'constructs';
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
export declare function applyRegelCoreTags(scope: IConstruct, props: RegelCoreTagProps): void;
/** @deprecated kept so v1 consumers can migrate by swapping the import without behavior change. */
export type ClawTagProps = RegelCoreTagProps;
/**
 * @deprecated Use `applyRegelCoreTags`. Matches legacy behavior: `Account` tag value is `claw`.
 * Retained for the rename overlap; drop in v2.
 */
export declare function applyClawTags(scope: IConstruct, props: ClawTagProps): void;
