/**
 * SendGrid provisioning (email service - alternative to Resend)
 * - Helps user save SendGrid credentials to 1Password vault
 * - SendGrid account must be created manually at sendgrid.com
 */

import { ensureOpAuth, opEnsureVault, opEnsureItemWithSections, ItemSection } from './op-util.js';
import { ProvisionOptions, SendGridResult } from './types.js';
import { RollbackAction } from './rollback.js';
import { getSendGridCredentials } from './credentials.js';
import { promptSecret } from './prompt-util.js';

/**
 * Provision SendGrid credentials (bring-your-own mode)
 * SendGrid account must be created manually at https://sendgrid.com/
 */
export async function provisionSendGrid(
  options: ProvisionOptions
): Promise<{ result: SendGridResult; rollbackActions: RollbackAction[] }> {
  const { projectName, envSuffix, verbose, dryRun } = options;
  const rollbackActions: RollbackAction[] = [];

  const vaultName = `${projectName}-${envSuffix}`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-');

  if (verbose) {
    console.log(`  SendGrid provisioning for vault: ${vaultName}`);
  }

  if (dryRun) {
    console.log(`  [DRY RUN] Would save SendGrid credentials to 1Password vault: ${vaultName}`);
    return {
      result: {
        apiKey: 'SG.dry_run_api_key'
      },
      rollbackActions
    };
  }

  // Try to get credentials from environment or credentials store
  let credentials = getSendGridCredentials();

  // If not found, prompt user interactively
  if (!credentials.apiKey) {
    console.log('\n  SendGrid API Key not found in environment.');
    console.log('  Please create a SendGrid account at https://sendgrid.com/');
    console.log('  Then create an API key from: https://app.sendgrid.com/settings/api_keys\n');

    const apiKey = await promptSecret('  Enter SendGrid API Key (starts with SG.)');
    credentials.apiKey = apiKey;
  }

  try {
    // Write to 1Password project vault
    ensureOpAuth();
    opEnsureVault(vaultName);

    // Create SendGrid item with sections
    const sendgridSections: ItemSection[] = [
      {
        label: 'Credentials',
        fields: [
          { label: 'api_key', value: credentials.apiKey!, type: 'CONCEALED' }
        ]
      }
    ];

    opEnsureItemWithSections(vaultName, 'Sendgrid', sendgridSections, undefined, verbose);

    if (verbose) {
      console.log(`  ✓ Wrote SendGrid credentials to 1Password vault: ${vaultName}`);
    } else {
      console.log(`  ✓ SendGrid: credentials saved`);
    }

    return {
      result: {
        apiKey: credentials.apiKey!
      },
      rollbackActions
    };
  } catch (e: any) {
    throw new Error(`SendGrid provisioning failed: ${e?.message || e}`);
  }
}

/**
 * List SendGrid instances (not applicable - SendGrid is bring-your-own)
 */
export async function listSendGridInstances(
  options: { projectName?: string; envSuffix?: 'dev' | 'prod'; filterPattern?: string; verbose?: boolean }
): Promise<Array<{ id: string; name: string; environment?: 'dev' | 'prod' | 'unknown'; metadata?: any }>> {
  // SendGrid doesn't have "instances" to list - it's a bring-your-own credentials service
  return [];
}

/**
 * Delete SendGrid instance (not applicable - SendGrid is bring-your-own)
 */
export async function deleteSendGridInstance(
  instanceId: string,
  options: { verbose?: boolean }
): Promise<{ id: string; name: string; success: boolean; error?: string }> {
  return {
    id: instanceId,
    name: 'SendGrid',
    success: false,
    error: 'SendGrid credentials are managed manually and should be removed from 1Password vault directly'
  };
}
