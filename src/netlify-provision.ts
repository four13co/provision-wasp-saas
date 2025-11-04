/**
 * Netlify provisioning (frontend hosting)
 * - Creates a Netlify site
 * - Sets environment variables
 * - Writes site details to 1Password vault
 */

import { execSync } from 'node:child_process';
import { ensureOpAuth, opEnsureVault } from './op-util.js';
import { ProvisionOptions, NetlifyResult } from './types.js';
import { createRollbackAction, RollbackAction } from './rollback.js';

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

function getNetlifyToken(): string {
  const token = process.env.NETLIFY_TOKEN;

  if (!token) {
    throw new Error('NETLIFY_TOKEN not set. Add to .env file:\n  NETLIFY_TOKEN=your-value\n\nOr use 1Password references with:\n  op run --env-file=".env" -- npx provision-wasp-saas ...');
  }

  return token;
}

/**
 * Provision a Netlify frontend site
 */
export async function provisionNetlify(
  options: ProvisionOptions
): Promise<{ result: NetlifyResult; rollbackActions: RollbackAction[] }> {
  const { projectName, envSuffix, verbose, dryRun } = options;
  const rollbackActions: RollbackAction[] = [];

  const netlifySiteName = `${projectName}-frontend-${envSuffix}`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-');
  const vaultName = `${projectName}-${envSuffix}`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-');

  if (verbose) {
    console.log(`  Netlify site name: ${netlifySiteName}`);
  }

  if (dryRun) {
    console.log(`  [DRY RUN] Would create Netlify site: ${netlifySiteName}`);
    return {
      result: {
        site: {
          id: 'dry-run-site-id',
          name: netlifySiteName,
          url: `https://${netlifySiteName}.netlify.app`
        }
      },
      rollbackActions
    };
  }

  const token = getNetlifyToken();

  // Check if site already exists
  let siteId = '';
  let siteUrl = '';

  try {
    const listResult = sh(
      `curl -s -H "Authorization: Bearer ${token}" "https://api.netlify.com/api/v1/sites"`,
      { capture: true, verbose }
    );

    const sites = JSON.parse(listResult);
    const existing = sites.find((s: any) => s.name === netlifySiteName);

    if (existing) {
      siteId = existing.id;
      siteUrl = existing.ssl_url || existing.url || `https://${netlifySiteName}.netlify.app`;

      if (verbose) {
        console.log(`  ✓ Found existing Netlify site: ${netlifySiteName} (${siteId})`);
      }
    } else {
      // Create new site
      const body = JSON.stringify({
        name: netlifySiteName
      });

      const createResult = sh(
        `curl -s -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '${body.replace(/'/g, "'\\''")}' "https://api.netlify.com/api/v1/sites"`,
        { capture: true, verbose }
      );

      const createData = JSON.parse(createResult);

      if (createData.error || createData.message) {
        throw new Error(`Failed to create Netlify site: ${createData.error || createData.message}`);
      }

      siteId = createData.id;
      siteUrl = createData.ssl_url || createData.url || `https://${netlifySiteName}.netlify.app`;

      if (verbose) {
        console.log(`  ✓ Created Netlify site: ${netlifySiteName} (${siteId})`);
      }

      // Add rollback action to delete the site
      rollbackActions.push(
        createRollbackAction(
          'netlify',
          `Delete Netlify site ${netlifySiteName} (${siteId})`,
          async () => {
            try {
              sh(
                `curl -s -X DELETE -H "Authorization: Bearer ${token}" "https://api.netlify.com/api/v1/sites/${siteId}"`,
                { verbose }
              );

              if (verbose) {
                console.log(`    Deleted Netlify site ${siteId}`);
              }
            } catch (e: any) {
              console.warn(`    Failed to delete Netlify site: ${e?.message || e}`);
            }
          }
        )
      );
    }

    // Set environment variables for the site
    // Note: Netlify doesn't have per-environment env vars like Vercel,
    // so we'll just set them for the site (affects all contexts)
    try {
      const envVars = [
        { key: 'ENABLE_EXPERIMENTAL_COREPACK', value: '1' }
      ];

      for (const envVar of envVars) {
        try {
          const envBody = JSON.stringify({
            key: envVar.key,
            values: [{ value: envVar.value, context: 'all' }]
          });

          sh(
            `curl -s -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '${envBody.replace(/'/g, "'\\''")}' "https://api.netlify.com/api/v1/sites/${siteId}/env"`,
            { verbose }
          );

          if (verbose) {
            console.log(`    Set ${envVar.key}=${envVar.value}`);
          }
        } catch (e: any) {
          if (verbose) {
            console.warn(`    Warning: Failed to set ${envVar.key}: ${e?.message || e}`);
          }
        }
      }

      if (verbose) {
        console.log(`  ✓ Configured environment variables`);
      }
    } catch (e: any) {
      if (verbose) {
        console.warn(`  Warning: Failed to configure environment variables: ${e?.message || e}`);
      }
    }

    // Write to 1Password project vault
    try {
      ensureOpAuth();
      opEnsureVault(vaultName);

      // Create or update NETLIFY item
      try {
        sh(`op item get --vault "${vaultName}" NETLIFY`, { verbose });
      } catch {
        sh(`op item create --vault "${vaultName}" --category=LOGIN --title "NETLIFY" --url=local`, { verbose });
      }

      const siteIdField = envSuffix === 'prod' ? 'NETLIFY_SITE_ID_PROD' : 'NETLIFY_SITE_ID_DEV';
      const siteNameField = envSuffix === 'prod' ? 'NETLIFY_SITE_NAME_PROD' : 'NETLIFY_SITE_NAME_DEV';

      sh(`op item edit --vault "${vaultName}" NETLIFY ${siteIdField}=${siteId}`, { verbose });
      sh(`op item edit --vault "${vaultName}" NETLIFY ${siteNameField}=${netlifySiteName}`, { verbose });
      sh(`op item edit --vault "${vaultName}" NETLIFY NETLIFY_TOKEN=${token}`, { verbose });

      // Store APP_URL
      try {
        sh(`op item get --vault "${vaultName}" APP_URL`, { verbose });
      } catch {
        sh(`op item create --vault "${vaultName}" --category=LOGIN --title "APP_URL" --url=local`, { verbose });
      }

      sh(`op item edit --vault "${vaultName}" APP_URL username='${siteUrl}'`, { verbose });

      if (verbose) {
        console.log(`  ✓ Wrote Netlify details to 1Password vault: ${vaultName}`);
      }
    } catch (e: any) {
      console.warn(`  Warning: Failed to write to 1Password: ${e?.message || e}`);
    }

    if (verbose) {
      console.log(`  ✓ Netlify site provisioned: ${netlifySiteName}`);
    } else {
      console.log(`  ✓ Netlify: ${netlifySiteName}`);
    }

    return {
      result: {
        site: {
          id: siteId,
          name: netlifySiteName,
          url: siteUrl
        }
      },
      rollbackActions
    };
  } catch (e: any) {
    throw new Error(`Netlify provisioning failed: ${e?.message || e}`);
  }
}

/**
 * List all Netlify sites for cleanup
 */
export async function listNetlifyInstances(
  options: { projectName?: string; envSuffix?: 'dev' | 'prod'; filterPattern?: string; verbose?: boolean }
): Promise<Array<{ id: string; name: string; environment?: 'dev' | 'prod' | 'unknown'; metadata?: any; createdAt?: string }>> {
  const { projectName, envSuffix, filterPattern, verbose } = options;

  // Get Netlify token
  const token = process.env.NETLIFY_TOKEN;

  if (!token) {
    throw new Error('NETLIFY_TOKEN not set. Add to .env file');
  }

  try {
    const resp = await fetch('https://api.netlify.com/api/v1/sites', {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!resp.ok) {
      throw new Error(`Failed to list Netlify sites: HTTP ${resp.status}`);
    }

    const sites = await resp.json() as any[];

    // Filter resources
    let matches = sites;

    if (filterPattern) {
      // Use custom filter pattern
      const pattern = filterPattern.toLowerCase();
      matches = matches.filter((site: any) => {
        const name = (site?.name || '').toLowerCase();
        return name.includes(pattern);
      });
    } else if (projectName) {
      // Filter by project name pattern
      const pattern = envSuffix
        ? `${projectName}-${envSuffix}`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-')
        : `${projectName}-`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-');

      matches = matches.filter((site: any) => {
        const name = (site?.name || '').toLowerCase();
        return envSuffix
          ? name === pattern
          : name.startsWith(pattern);
      });
    }
    // If neither filterPattern nor projectName: return all resources

    return matches.map((site: any) => {
      const name = site.name || site.id;
      const env = name.endsWith('-dev') ? 'dev' as const
        : name.endsWith('-prod') ? 'prod' as const
        : 'unknown' as const;

      return {
        id: site.id,
        name: site.name,
        environment: env,
        metadata: {
          url: site.ssl_url || site.url,
          state: site.state,
          plan: site.plan
        },
        createdAt: site.created_at ? new Date(site.created_at).toISOString() : undefined
      };
    });
  } catch (error: any) {
    if (verbose) {
      console.warn(`  Warning: Failed to list Netlify sites: ${error?.message || error}`);
    }
    return [];
  }
}

/**
 * Delete a Netlify site by ID
 */
export async function deleteNetlifyInstance(
  instanceId: string,
  options: { verbose?: boolean }
): Promise<{ id: string; name: string; success: boolean; error?: string }> {
  const { verbose } = options;

  // Get Netlify token
  const token = process.env.NETLIFY_TOKEN;

  if (!token) {
    return {
      id: instanceId,
      name: instanceId,
      success: false,
      error: 'NETLIFY_TOKEN not set. Add to .env file'
    };
  }

  try {
    const resp = await fetch(`https://api.netlify.com/api/v1/sites/${instanceId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!resp.ok) {
      const errorData: any = await resp.json().catch(() => ({}));
      return {
        id: instanceId,
        name: instanceId,
        success: false,
        error: errorData?.message || `HTTP ${resp.status}`
      };
    }

    if (verbose) {
      console.log(`    Deleted Netlify site ${instanceId}`);
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
