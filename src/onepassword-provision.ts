/**
 * 1Password vault provisioning
 * - Creates project vault
 * - Creates Auth item with JWT_SECRET
 */

import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import { ensureOpAuth, opEnsureVault, opEnsureItemWithSections, ItemSection } from './op-util.js';
import { OnePasswordOptions, OnePasswordResult } from './types.js';
import { RollbackAction } from './rollback.js';

function sh(cmd: string, verbose?: boolean) {
  if (verbose) console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: verbose ? 'inherit' : 'ignore' });
}

/**
 * Provision a 1Password vault for the project
 */
export async function provisionOnePassword(
  options: OnePasswordOptions
): Promise<{ result: OnePasswordResult; rollbackActions: RollbackAction[] }> {
  const { vaultName, projectName, envSuffix, verbose, dryRun } = options;
  const rollbackActions: RollbackAction[] = [];

  if (verbose) {
    console.log(`  1Password vault: ${vaultName}`);
  }

  if (dryRun) {
    console.log(`  [DRY RUN] Would create 1Password vault: ${vaultName}`);
    return {
      result: { vaultName },
      rollbackActions
    };
  }

  try {
    ensureOpAuth();
    const vaultResult = opEnsureVault(vaultName, verbose);

    if (!verbose) {
      // Only show simple message if not verbose (verbose mode already showed details)
      if (vaultResult.existed) {
        console.log(`  ✓ Using existing vault: ${vaultName}`);
      } else {
        console.log(`  ✓ Created vault: ${vaultName}`);
      }
    }

    // Generate and store JWT secret in Auth item
    const jwtSecret = crypto.randomBytes(32).toString('hex');

    const authSections: ItemSection[] = [
      {
        label: 'Secrets',
        fields: [
          {
            label: 'jwt_secret',
            value: jwtSecret,
            type: 'CONCEALED'
          }
        ]
      }
    ];

    opEnsureItemWithSections(vaultName, 'Auth', authSections, undefined, verbose);

    if (verbose) {
      console.log(`  ✓ Created Auth item with JWT secret`);
      console.log(`  ✓ 1Password vault provisioned: ${vaultName}`);
    } else {
      console.log(`  ✓ 1Password: ${vaultName}`);
    }

    return {
      result: {
        vaultName,
        vaultId: undefined // We don't retrieve the vault ID in this implementation
      },
      rollbackActions
    };
  } catch (e: any) {
    throw new Error(`1Password provisioning failed: ${e?.message || e}`);
  }
}

/**
 * List all 1Password vaults for cleanup
 */
export async function listOnePasswordInstances(
  options: { projectName?: string; envSuffix?: 'dev' | 'prod'; filterPattern?: string; verbose?: boolean }
): Promise<Array<{ id: string; name: string; environment?: 'dev' | 'prod' | 'unknown'; metadata?: any; createdAt?: string }>> {
  const { projectName, envSuffix, filterPattern, verbose } = options;

  try {
    ensureOpAuth();

    // List all vaults
    const output = execSync('op vault list --format=json', { stdio: 'pipe' }).toString();
    const vaults = JSON.parse(output) as any[];

    // Filter resources
    let matches = vaults;

    if (filterPattern) {
      // Use custom filter pattern
      const pattern = filterPattern.toLowerCase();
      matches = matches.filter((vault: any) => {
        const name = (vault?.name || '').toLowerCase();
        return name.includes(pattern);
      });
    } else if (projectName) {
      // Filter by project name pattern
      const pattern = envSuffix
        ? `${projectName}-${envSuffix}`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-')
        : `${projectName}-`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-');

      matches = matches.filter((vault: any) => {
        const name = (vault?.name || '').toLowerCase();
        return envSuffix
          ? name === pattern
          : name.startsWith(pattern);
      });
    }
    // If neither filterPattern nor projectName: return all resources

    return matches.map((vault: any) => {
      const name = vault.name || vault.id;
      const env = name.endsWith('-dev') ? 'dev' as const
        : name.endsWith('-prod') ? 'prod' as const
        : 'unknown' as const;

      return {
        id: vault.id,
        name: vault.name,
        environment: env,
        metadata: {
          type: vault.type,
          attributeVersion: vault.attribute_version
        },
        createdAt: vault.created_at
      };
    });
  } catch (error: any) {
    if (verbose) {
      console.warn(`  Warning: Failed to list 1Password vaults: ${error?.message || error}`);
    }
    return [];
  }
}

/**
 * Delete a 1Password vault by ID
 */
export async function deleteOnePasswordInstance(
  instanceId: string,
  options: { verbose?: boolean }
): Promise<{ id: string; name: string; success: boolean; error?: string }> {
  const { verbose } = options;

  try {
    ensureOpAuth();

    // Delete vault (op CLI automatically confirms in non-interactive mode)
    sh(`op vault delete "${instanceId}"`, verbose);

    if (verbose) {
      console.log(`    Deleted 1Password vault ${instanceId}`);
    }

    return {
      id: instanceId,
      name: instanceId,
      success: true
    };
  } catch (error: any) {
    return {
      id: instanceId,
      name: instanceId,
      success: false,
      error: error?.message || String(error)
    };
  }
}
