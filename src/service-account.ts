/**
 * 1Password Service Account Management
 * Creates service accounts and manages GitHub secrets
 */

import { execSync } from 'node:child_process';
import { RollbackAction, createRollbackAction } from './rollback.js';

export interface ServiceAccountOptions {
  name: string;
  vault: string;
  permissions?: string[];
  expiresIn?: string;
  verbose?: boolean;
}

export interface ServiceAccountResult {
  name: string;
  token: string;
}

export interface GitHubSecretOptions {
  repo: string;
  secretName: string;
  secretValue: string;
  verbose?: boolean;
}

/**
 * Create a 1Password service account with vault access
 * Returns the service account token (only available once!)
 */
export async function createServiceAccount(
  options: ServiceAccountOptions
): Promise<ServiceAccountResult> {
  const { name, vault, permissions = ['read_items'], expiresIn, verbose } = options;

  try {
    // Build permission string
    const permissionStr = permissions.join(',');
    const vaultAccess = `${vault}:${permissionStr}`;

    // Build command
    let cmd = `op service-account create "${name}" --vault "${vaultAccess}" --raw`;

    if (expiresIn) {
      cmd += ` --expires-in "${expiresIn}"`;
    }

    if (verbose) {
      console.log(`  Creating service account: ${name}`);
      console.log(`  Vault access: ${vaultAccess}`);
    }

    // Execute command and capture token
    const token = execSync(cmd, {
      stdio: 'pipe',
      encoding: 'utf-8'
    }).trim();

    if (!token || !token.startsWith('ops_')) {
      throw new Error(`Invalid service account token received: ${token.substring(0, 10)}...`);
    }

    if (verbose) {
      console.log(`  ✓ Service account created: ${name}`);
      console.log(`  Token: ${token.substring(0, 15)}...`);
    }

    return {
      name,
      token
    };
  } catch (error: any) {
    throw new Error(`Failed to create service account '${name}': ${error.message}`);
  }
}

/**
 * Set a GitHub secret using gh CLI
 */
export async function setGitHubSecret(options: GitHubSecretOptions): Promise<void> {
  const { repo, secretName, secretValue, verbose } = options;

  try {
    if (verbose) {
      console.log(`  Setting GitHub secret: ${secretName}`);
    }

    // Use gh CLI to set secret
    // Pass secret value via stdin to avoid shell escaping issues
    execSync(`gh secret set "${secretName}" --repo "${repo}"`, {
      input: secretValue,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8'
    });

    if (verbose) {
      console.log(`  ✓ Secret set: ${secretName}`);
    }
  } catch (error: any) {
    throw new Error(`Failed to set GitHub secret '${secretName}': ${error.message}`);
  }
}

/**
 * Delete a GitHub secret (used for rollback)
 */
export async function deleteGitHubSecret(
  repo: string,
  secretName: string,
  verbose?: boolean
): Promise<void> {
  try {
    if (verbose) {
      console.log(`  Deleting GitHub secret: ${secretName}`);
    }

    execSync(`gh secret delete "${secretName}" --repo "${repo}"`, {
      stdio: verbose ? 'inherit' : 'pipe',
      encoding: 'utf-8'
    });

    if (verbose) {
      console.log(`  ✓ Secret deleted: ${secretName}`);
    }
  } catch (error: any) {
    // Don't throw - secret might not exist
    if (verbose) {
      console.warn(`  Warning: Could not delete secret '${secretName}': ${error.message}`);
    }
  }
}

/**
 * Check if a GitHub secret exists
 */
export async function gitHubSecretExists(repo: string, secretName: string): Promise<boolean> {
  try {
    execSync(`gh secret list --repo "${repo}" | grep -q "^${secretName}"`, {
      stdio: 'pipe',
      encoding: 'utf-8'
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get GitHub repository owner
 */
export function getGitHubOwner(): string {
  try {
    // Try to get from current repo first
    const owner = execSync('gh repo view --json owner -q .owner.login', {
      stdio: 'pipe',
      encoding: 'utf-8'
    }).trim();
    return owner;
  } catch {
    // Fall back to authenticated user
    const user = execSync('gh api user -q .login', {
      stdio: 'pipe',
      encoding: 'utf-8'
    }).trim();
    return user;
  }
}

export interface SecretValidationResult {
  exists: boolean;
  valid: boolean;
  errors: string[];
}

/**
 * Validate GitHub secrets for an environment
 * Checks if secrets exist and if the service account token is valid
 */
export async function validateGitHubSecrets(
  repo: string,
  environment: 'dev' | 'prod',
  vaultName: string,
  verbose?: boolean
): Promise<SecretValidationResult> {
  const errors: string[] = [];
  const envUpper = environment.toUpperCase();
  const tokenSecretName = `OP_SERVICE_ACCOUNT_TOKEN_${envUpper}`;
  const vaultSecretName = `OP_VAULT_${envUpper}`;

  if (verbose) {
    console.log(`  Validating GitHub secrets for ${environment}...`);
  }

  try {
    // Check if secrets exist
    const secretsList = execSync(`gh secret list --repo "${repo}"`, {
      stdio: 'pipe',
      encoding: 'utf-8'
    });

    const tokenExists = secretsList.includes(tokenSecretName);
    const vaultExists = secretsList.includes(vaultSecretName);

    if (!tokenExists) {
      errors.push(`Secret ${tokenSecretName} does not exist`);
    }

    if (!vaultExists) {
      errors.push(`Secret ${vaultSecretName} does not exist`);
    }

    if (!tokenExists || !vaultExists) {
      return {
        exists: false,
        valid: false,
        errors
      };
    }

    // Secrets exist, but we can't validate the token value without the actual token
    // (GitHub doesn't expose secret values via API for security reasons)
    // We'll consider secrets valid if they exist
    // Users can force reprovision with --force flag if tokens are invalid

    if (verbose) {
      console.log(`  ✓ GitHub secrets exist for ${environment}`);
    }

    return {
      exists: true,
      valid: true,
      errors: []
    };
  } catch (error: any) {
    errors.push(`Failed to validate secrets: ${error.message}`);
    return {
      exists: false,
      valid: false,
      errors
    };
  }
}

/**
 * Create rollback action for deleting a GitHub secret
 */
export function createGitHubSecretRollback(
  repo: string,
  secretName: string
): RollbackAction {
  return createRollbackAction(
    'github',
    `Delete GitHub secret ${secretName}`,
    async () => {
      await deleteGitHubSecret(repo, secretName, false);
    }
  );
}

/**
 * Setup service account and GitHub secrets for an environment
 * This is the main function that orchestrates everything
 *
 * Optionally updates CapRover app environment variables if caprover option is provided
 */
export async function setupServiceAccountAndSecrets(options: {
  projectName: string;
  environment: 'dev' | 'prod';
  vaultName: string;
  repo: string;
  verbose?: boolean;
  force?: boolean;
  caprover?: {
    appName: string;
    url?: string;
    password?: string;
  };
}): Promise<{ rollbackActions: RollbackAction[]; skipped: boolean }> {
  const { projectName, environment, vaultName, repo, verbose, force = false } = options;
  const rollbackActions: RollbackAction[] = [];

  // Check existing secrets unless force mode is enabled
  if (!force) {
    const validation = await validateGitHubSecrets(repo, environment, vaultName, verbose);

    if (validation.exists && validation.valid) {
      if (verbose) {
        console.log(`  ✓ GitHub secrets for ${environment} already configured and valid`);
      }
      return { rollbackActions, skipped: true };
    }

    if (validation.exists && !validation.valid) {
      if (verbose) {
        console.log(`  ⚠ Existing secrets for ${environment} are invalid, reprovisioning...`);
        validation.errors.forEach(err => console.log(`    - ${err}`));
      }
    }
  } else if (verbose) {
    console.log(`  Force mode enabled, reprovisioning secrets for ${environment}...`);
  }

  const envUpper = environment.toUpperCase();
  const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').substring(0, 14);
  const serviceAccountName = `${projectName}-sa-${environment}-github-v${timestamp}`;

  // Check if CapRover service account exists (informational only)
  try {
    const { ensureOpAuth, opGetItem, opItemField } = await import('./op-util.js');
    ensureOpAuth();
    const caproverItem = opGetItem(vaultName, 'CapRover');
    if (caproverItem) {
      const caproverServiceAccount = opItemField(caproverItem, 'ServiceAccount.service_account_name');
      if (caproverServiceAccount && verbose) {
        console.log(`  ℹ CapRover service account already exists: ${caproverServiceAccount}`);
        console.log(`  Creating separate service account for GitHub Actions...`);
      }
    }
  } catch {
    // No CapRover service account exists yet, that's fine
  }

  try {
    // 1. Create service account for GitHub Actions
    if (verbose) {
      console.log(`  Creating service account for ${environment} GitHub Actions...`);
    }

    const serviceAccount = await createServiceAccount({
      name: serviceAccountName,
      vault: vaultName,
      permissions: ['read_items'],
      verbose
    });

    // 2. Set GitHub secrets
    const tokenSecretName = `OP_SERVICE_ACCOUNT_TOKEN_${envUpper}`;
    const vaultSecretName = `OP_VAULT_${envUpper}`;

    await setGitHubSecret({
      repo,
      secretName: tokenSecretName,
      secretValue: serviceAccount.token,
      verbose
    });

    // Add rollback for token secret
    rollbackActions.push(createGitHubSecretRollback(repo, tokenSecretName));

    await setGitHubSecret({
      repo,
      secretName: vaultSecretName,
      secretValue: vaultName,
      verbose
    });

    // Add rollback for vault secret
    rollbackActions.push(createGitHubSecretRollback(repo, vaultSecretName));

    if (verbose) {
      console.log(`  ✓ Service account and secrets configured for ${environment}`);
    }

    // Update CapRover environment variables if requested
    if (options.caprover) {
      try {
        const { updateCapRoverEnvVars } = await import('./caprover-provision.js');
        const { opReadField } = await import('./op-util.js');

        if (verbose) {
          console.log(`  Updating CapRover app environment variables...`);
        }

        // Build env vars array starting with service account credentials
        const envVars: Array<{ key: string; value: string }> = [
          { key: 'OP_SERVICE_ACCOUNT_TOKEN', value: serviceAccount.token },
          { key: 'OP_VAULT', value: vaultName }
        ];

        // Try to add GitHub credentials if they exist in the vault
        try {
          const githubPat = opReadField(vaultName, 'GitHub', 'Credentials', 'pat');
          const githubUsername = opReadField(vaultName, 'GitHub', 'Registry', 'username');

          if (githubPat && githubUsername) {
            envVars.push(
              { key: 'GITHUB_PAT', value: githubPat },
              { key: 'GITHUB_USERNAME', value: githubUsername }
            );
            if (verbose) {
              console.log(`  Including GitHub credentials in CapRover update`);
            }
          }
        } catch (e: any) {
          if (verbose) {
            console.log(`  Note: GitHub credentials not found in vault, skipping`);
          }
        }

        await updateCapRoverEnvVars(
          options.caprover.appName,
          envVars,
          {
            url: options.caprover.url,
            password: options.caprover.password,
            verbose
          }
        );

        if (verbose) {
          console.log(`  ✓ CapRover environment variables updated`);
        }
      } catch (error: any) {
        // Don't fail the entire operation if CapRover update fails
        console.warn(`  Warning: Failed to update CapRover env vars: ${error.message}`);
        console.warn(`  You can manually set these in CapRover:`);
        console.warn(`    - OP_SERVICE_ACCOUNT_TOKEN`);
        console.warn(`    - OP_VAULT=${vaultName}`);
        console.warn(`    - GITHUB_PAT (if available)`);
        console.warn(`    - GITHUB_USERNAME (if available)`);
      }
    }

    return { rollbackActions, skipped: false };
  } catch (error: any) {
    throw new Error(`Failed to setup service account for ${environment}: ${error.message}`);
  }
}
