/**
 * Google OAuth provisioning (social authentication)
 * - Helps user save Google OAuth credentials to 1Password vault
 * - Google Cloud project and OAuth credentials must be created manually
 */

import { ensureOpAuth, opEnsureVault, opEnsureItemWithSections, ItemSection } from './op-util.js';
import { ProvisionOptions, GoogleOAuthResult } from './types.js';
import { RollbackAction } from './rollback.js';
import { getGoogleOAuthCredentials } from './credentials.js';
import { promptText, promptSecret } from './prompt-util.js';

/**
 * Provision Google OAuth credentials (bring-your-own mode)
 * Google Cloud project must be created manually at https://console.cloud.google.com/
 */
export async function provisionGoogleOAuth(
  options: ProvisionOptions
): Promise<{ result: GoogleOAuthResult; rollbackActions: RollbackAction[] }> {
  const { projectName, envSuffix, verbose, dryRun } = options;
  const rollbackActions: RollbackAction[] = [];

  const vaultName = `${projectName}-${envSuffix}`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-');

  if (verbose) {
    console.log(`  Google OAuth provisioning for vault: ${vaultName}`);
  }

  if (dryRun) {
    console.log(`  [DRY RUN] Would save Google OAuth credentials to 1Password vault: ${vaultName}`);
    return {
      result: {
        clientId: '123456789-abcdefghijk.apps.googleusercontent.com',
        clientSecret: 'GOCSPX-dry_run_secret'
      },
      rollbackActions
    };
  }

  // Try to get credentials from environment or credentials store
  let credentials = getGoogleOAuthCredentials();

  // If not found, prompt user interactively
  if (!credentials.clientId) {
    console.log('\n  Google OAuth credentials not found in environment.');
    console.log('  Please create a Google Cloud project at https://console.cloud.google.com/');
    console.log('  Then create OAuth 2.0 credentials from: https://console.cloud.google.com/apis/credentials');
    console.log('  Select "OAuth 2.0 Client IDs" and configure for Web application\n');

    const clientId = await promptText('  Enter Google OAuth Client ID (ends with .apps.googleusercontent.com)');
    credentials.clientId = clientId;
  }

  if (!credentials.clientSecret) {
    const clientSecret = await promptSecret('  Enter Google OAuth Client Secret (starts with GOCSPX-)');
    credentials.clientSecret = clientSecret;
  }

  try {
    // Write to 1Password project vault
    ensureOpAuth();
    opEnsureVault(vaultName);

    // Create Google item with sections
    const googleSections: ItemSection[] = [
      {
        label: 'OAuth',
        fields: [
          { label: 'client_id', value: credentials.clientId!, type: 'STRING' },
          { label: 'client_secret', value: credentials.clientSecret!, type: 'CONCEALED' }
        ]
      }
    ];

    opEnsureItemWithSections(vaultName, 'Google', googleSections, undefined, verbose);

    if (verbose) {
      console.log(`  ✓ Wrote Google OAuth credentials to 1Password vault: ${vaultName}`);
    } else {
      console.log(`  ✓ Google OAuth: credentials saved`);
    }

    return {
      result: {
        clientId: credentials.clientId!,
        clientSecret: credentials.clientSecret!
      },
      rollbackActions
    };
  } catch (e: any) {
    throw new Error(`Google OAuth provisioning failed: ${e?.message || e}`);
  }
}

/**
 * List Google OAuth instances (not applicable - Google OAuth is bring-your-own)
 */
export async function listGoogleOAuthInstances(
  options: { projectName?: string; envSuffix?: 'dev' | 'prod'; filterPattern?: string; verbose?: boolean }
): Promise<Array<{ id: string; name: string; environment?: 'dev' | 'prod' | 'unknown'; metadata?: any }>> {
  // Google OAuth doesn't have "instances" to list - it's a bring-your-own credentials service
  return [];
}

/**
 * Delete Google OAuth instance (not applicable - Google OAuth is bring-your-own)
 */
export async function deleteGoogleOAuthInstance(
  instanceId: string,
  options: { verbose?: boolean }
): Promise<{ id: string; name: string; success: boolean; error?: string }> {
  return {
    id: instanceId,
    name: 'Google OAuth',
    success: false,
    error: 'Google OAuth credentials are managed manually and should be removed from 1Password vault directly'
  };
}
