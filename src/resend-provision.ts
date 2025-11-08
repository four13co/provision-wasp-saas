/**
 * Resend provisioning (email service)
 * - Creates a Resend API key
 * - Writes key to 1Password vault
 */

import { execSync } from 'node:child_process';
import { ensureOpAuth, opGetItem, opItemField, opReadRef, opEnsureVault, opEnsureItemWithSections, ItemSection } from './op-util.js';
import { ProvisionOptions, ResendResult } from './types.js';
import { createRollbackAction, RollbackAction } from './rollback.js';
import { getResendCredentials, getMissingCredentialsMessage } from './credentials.js';
import { retryFetch } from './retry-util.js';

function sh(cmd: string, opts: { capture?: boolean; verbose?: boolean } = {}) {
  if (opts.capture) {
    return execSync(cmd, { stdio: 'pipe' }).toString();
  }

  if (opts.verbose) {
    console.log(`$ ${cmd}`);
    execSync(cmd, { stdio: 'inherit' });
  } else {
    execSync(cmd, { stdio: 'ignore' });
  }

  return '';
}

function getResendMasterKey(): string {
  const credentials = getResendCredentials();
  const key = credentials.apiKey;

  if (!key) {
    throw new Error(getMissingCredentialsMessage('resend') + '\nSpecifically missing: RESEND_API_KEY');
  }

  return key;
}

/**
 * Provision a Resend API key
 */
export async function provisionResend(
  options: ProvisionOptions
): Promise<{ result: ResendResult; rollbackActions: RollbackAction[] }> {
  const { projectName, envSuffix, verbose, dryRun } = options;
  const rollbackActions: RollbackAction[] = [];

  const keyName = `${projectName}-${envSuffix}`;
  const vaultName = `${projectName}-${envSuffix}`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-');

  if (verbose) {
    console.log(`  Resend API key name: ${keyName}`);
  }

  if (dryRun) {
    console.log(`  [DRY RUN] Would create Resend API key: ${keyName}`);
    return {
      result: {
        key: {
          id: 'dry-run-key-id',
          token: 're_dry_run_token',
          name: keyName
        }
      },
      rollbackActions
    };
  }

  const masterKey = getResendMasterKey();

  try {
    // Create API key via Resend API with retry logic
    const response = await retryFetch(
      'https://api.resend.com/api-keys',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${masterKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: keyName,
          permission: 'sending_access'
        })
      },
      {
        maxRetries: 3,
        verbose: verbose
      }
    );

    const data = await response.json() as { id: string; token: string };

    if (verbose) {
      console.log(`  ✓ Created Resend API key: ${keyName} (${data.id})`);
    }

    // Add rollback action to delete the key
    rollbackActions.push(
      createRollbackAction(
        'resend',
        `Delete Resend API key ${keyName} (${data.id})`,
        async () => {
          try {
            await retryFetch(
              `https://api.resend.com/api-keys/${data.id}`,
              {
                method: 'DELETE',
                headers: {
                  'Authorization': `Bearer ${masterKey}`
                }
              },
              {
                maxRetries: 2,
                verbose: false
              }
            );

            if (verbose) {
              console.log(`    Deleted Resend API key ${data.id}`);
            }
          } catch (e: any) {
            console.warn(`    Failed to delete Resend API key: ${e?.message || e}`);
          }
        }
      )
    );

    // Write to 1Password project vault
    try {
      ensureOpAuth();
      opEnsureVault(vaultName);

      // Compute email from address
      const emailFrom = envSuffix === 'prod'
        ? `no-reply@${projectName}.com`
        : `no-reply@dev.${projectName}.com`;

      // Create Resend item with sections
      const resendSections: ItemSection[] = [
        {
          label: 'Credentials',
          fields: [
            { label: 'api_key_id', value: data.id, type: 'STRING' },
            { label: 'api_key', value: data.token, type: 'CONCEALED' }
          ]
        },
        {
          label: 'Configuration',
          fields: [
            { label: 'email_from', value: emailFrom, type: 'EMAIL' }
          ]
        }
      ];

      opEnsureItemWithSections(vaultName, 'Resend', resendSections, undefined, verbose);

      if (verbose) {
        console.log(`  ✓ Wrote Resend details to 1Password vault: ${vaultName}`);
      }
    } catch (e: any) {
      console.warn(`  Warning: Failed to write to 1Password: ${e?.message || e}`);
    }

    if (verbose) {
      console.log(`  ✓ Resend API key provisioned: ${keyName}`);
    } else {
      console.log(`  ✓ Resend: ${keyName}`);
    }

    return {
      result: {
        key: {
          id: data.id,
          token: data.token,
          name: keyName
        }
      },
      rollbackActions
    };
  } catch (e: any) {
    throw new Error(`Resend provisioning failed: ${e?.message || e}`);
  }
}

/**
 * List all Resend API keys for cleanup
 */
export async function listResendInstances(
  options: { projectName?: string; envSuffix?: 'dev' | 'prod'; filterPattern?: string; verbose?: boolean }
): Promise<Array<{ id: string; name: string; environment?: 'dev' | 'prod' | 'unknown'; metadata?: any; createdAt?: string }>> {
  const { projectName, envSuffix, filterPattern, verbose } = options;

  // Get Resend API key
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    throw new Error('RESEND_API_KEY not set. Add to .env file');
  }

  try {
    const resp = await retryFetch(
      'https://api.resend.com/api-keys',
      {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      },
      {
        maxRetries: 3,
        verbose: verbose
      }
    );

    const data: any = await resp.json();
    const keys = data?.data || [];

    // Filter resources
    let matches = keys;

    if (filterPattern) {
      // Use custom filter pattern
      const pattern = filterPattern.toLowerCase();
      matches = matches.filter((key: any) => {
        const name = (key?.name || '').toLowerCase();
        return name.includes(pattern);
      });
    } else if (projectName) {
      // Filter by project name pattern
      const pattern = envSuffix
        ? `${projectName}-${envSuffix}`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-')
        : `${projectName}-`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-');

      matches = matches.filter((key: any) => {
        const name = (key?.name || '').toLowerCase();
        return envSuffix
          ? name === pattern
          : name.startsWith(pattern);
      });
    }
    // If neither filterPattern nor projectName: return all resources

    return matches.map((key: any) => {
      const name = key.name || key.id;
      const env = name.endsWith('-dev') ? 'dev' as const
        : name.endsWith('-prod') ? 'prod' as const
        : 'unknown' as const;

      return {
        id: key.id,
        name: key.name,
        environment: env,
        metadata: {
          permission: key.permission
        },
        createdAt: key.created_at
      };
    });
  } catch (error: any) {
    if (verbose) {
      console.warn(`  Warning: Failed to list Resend API keys: ${error?.message || error}`);
    }
    return [];
  }
}

/**
 * Delete a Resend API key by ID
 */
export async function deleteResendInstance(
  instanceId: string,
  options: { verbose?: boolean }
): Promise<{ id: string; name: string; success: boolean; error?: string }> {
  const { verbose } = options;

  // Get Resend API key
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    return {
      id: instanceId,
      name: instanceId,
      success: false,
      error: 'RESEND_API_KEY not set. Add to .env file'
    };
  }

  try {
    await retryFetch(
      `https://api.resend.com/api-keys/${instanceId}`,
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${apiKey}` }
      },
      {
        maxRetries: 3,
        verbose: verbose
      }
    );

    if (verbose) {
      console.log(`    Deleted Resend API key ${instanceId}`);
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
