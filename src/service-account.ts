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
 */
export async function setupServiceAccountAndSecrets(options: {
  projectName: string;
  environment: 'dev' | 'prod';
  vaultName: string;
  repo: string;
  verbose?: boolean;
}): Promise<{ rollbackActions: RollbackAction[] }> {
  const { projectName, environment, vaultName, repo, verbose } = options;
  const rollbackActions: RollbackAction[] = [];

  const envUpper = environment.toUpperCase();
  const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').substring(0, 14);
  const serviceAccountName = `${projectName}-sa-${environment}-v${timestamp}`;

  try {
    // 1. Create service account
    if (verbose) {
      console.log(`  Setting up service account for ${environment} environment...`);
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

    return { rollbackActions };
  } catch (error: any) {
    throw new Error(`Failed to setup service account for ${environment}: ${error.message}`);
  }
}
