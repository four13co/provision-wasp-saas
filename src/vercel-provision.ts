/**
 * Vercel provisioning (frontend hosting)
 * - Creates a Vercel project
 * - Sets environment variables
 * - Writes project details to 1Password vault
 */

import { execSync } from 'node:child_process';
import { ensureOpAuth, opGetItem, opItemField, opReadRef, opEnsureVault, opEnsureItemWithSections, ItemSection } from './op-util.js';
import { ProvisionOptions, VercelResult } from './types.js';
import { createRollbackAction, RollbackAction } from './rollback.js';
import { getVercelCredentials, getMissingCredentialsMessage } from './credentials.js';
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

function getVercelToken(): string {
  const credentials = getVercelCredentials();
  const token = credentials.token;

  if (!token) {
    throw new Error(getMissingCredentialsMessage('vercel') + '\nSpecifically missing: VERCEL_TOKEN');
  }

  return token;
}

function getVercelOrgId(): string | undefined {
  const credentials = getVercelCredentials();
  return credentials.teamId || undefined;
}

/**
 * Provision a Vercel frontend project
 */
export async function provisionVercel(
  options: ProvisionOptions
): Promise<{ result: VercelResult; rollbackActions: RollbackAction[] }> {
  const { projectName, envSuffix, verbose, dryRun } = options;
  const rollbackActions: RollbackAction[] = [];

  const vercelProjectName = `${projectName}-frontend-${envSuffix}`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-');
  const vaultName = `${projectName}-${envSuffix}`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-');

  if (verbose) {
    console.log(`  Vercel project name: ${vercelProjectName}`);
  }

  if (dryRun) {
    console.log(`  [DRY RUN] Would create Vercel project: ${vercelProjectName}`);
    return {
      result: {
        project: {
          id: 'dry-run-project-id',
          name: vercelProjectName,
          url: `https://${vercelProjectName}.vercel.app`
        }
      },
      rollbackActions
    };
  }

  const token = getVercelToken();
  const orgId = getVercelOrgId();

  // Check if project already exists
  const listUrl = orgId
    ? `https://api.vercel.com/v9/projects?teamId=${orgId}`
    : 'https://api.vercel.com/v9/projects';

  let projectId = '';
  let projectUrl = '';

  try {
    const listResult = sh(
      `curl -s -H "Authorization: Bearer ${token}" "${listUrl}"`,
      { capture: true, verbose }
    );

    const listData = JSON.parse(listResult);
    const existing = (listData.projects || []).find((p: any) => p.name === vercelProjectName);

    if (existing) {
      projectId = existing.id;
      projectUrl = `https://${vercelProjectName}.vercel.app`;

      if (verbose) {
        console.log(`  ✓ Found existing Vercel project: ${vercelProjectName} (${projectId})`);
      }
    } else {
      // Create new project
      const body = JSON.stringify({
        name: vercelProjectName,
        framework: 'nextjs'
      });

      const createUrl = orgId
        ? `https://api.vercel.com/v9/projects?teamId=${orgId}`
        : 'https://api.vercel.com/v9/projects';

      const createResult = sh(
        `curl -s -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '${body.replace(/'/g, "'\\''")}' "${createUrl}"`,
        { capture: true, verbose }
      );

      const createData = JSON.parse(createResult);

      if (createData.error) {
        throw new Error(`Failed to create Vercel project: ${createData.error.message}`);
      }

      projectId = createData.id;
      projectUrl = `https://${vercelProjectName}.vercel.app`;

      if (verbose) {
        console.log(`  ✓ Created Vercel project: ${vercelProjectName} (${projectId})`);
      }

      // Add rollback action to delete the project
      rollbackActions.push(
        createRollbackAction(
          'vercel',
          `Delete Vercel project ${vercelProjectName} (${projectId})`,
          async () => {
            try {
              const deleteUrl = orgId
                ? `https://api.vercel.com/v9/projects/${projectId}?teamId=${orgId}`
                : `https://api.vercel.com/v9/projects/${projectId}`;

              sh(
                `curl -s -X DELETE -H "Authorization: Bearer ${token}" "${deleteUrl}"`,
                { verbose }
              );

              if (verbose) {
                console.log(`    Deleted Vercel project ${projectId}`);
              }
            } catch (e: any) {
              console.warn(`    Failed to delete Vercel project: ${e?.message || e}`);
            }
          }
        )
      );
    }

    // Set ENABLE_EXPERIMENTAL_COREPACK for pnpm support
    const setEnvVar = (key: string, value: string, target: 'production' | 'preview' | 'development') => {
      try {
        const envBody = JSON.stringify({
          key,
          value,
          target: [target],
          type: 'encrypted'
        });

        const envUrl = orgId
          ? `https://api.vercel.com/v10/projects/${projectId}/env?teamId=${orgId}`
          : `https://api.vercel.com/v10/projects/${projectId}/env`;

        sh(
          `curl -s -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '${envBody.replace(/'/g, "'\\''")}' "${envUrl}"`,
          { verbose }
        );

        if (verbose) {
          console.log(`    Set ${key}=${value} (${target})`);
        }
      } catch (e: any) {
        if (verbose) {
          console.warn(`    Warning: Failed to set ${key}: ${e?.message || e}`);
        }
      }
    };

    // Set pnpm support environment variable
    setEnvVar('ENABLE_EXPERIMENTAL_COREPACK', '1', 'production');
    setEnvVar('ENABLE_EXPERIMENTAL_COREPACK', '1', 'preview');
    setEnvVar('ENABLE_EXPERIMENTAL_COREPACK', '1', 'development');

    if (verbose) {
      console.log(`  ✓ Configured environment variables`);
    }

    // Write to 1Password project vault
    try {
      ensureOpAuth();
      opEnsureVault(vaultName);

      // Create Vercel item with sections
      const vercelSections: ItemSection[] = [
        {
          label: 'Project',
          fields: [
            { label: 'project_id', value: projectId, type: 'STRING' },
            { label: 'project_name', value: vercelProjectName, type: 'STRING' }
          ]
        },
        {
          label: 'Credentials',
          fields: [
            { label: 'token', value: token, type: 'CONCEALED' }
          ]
        },
        {
          label: 'URLs',
          fields: [
            { label: 'app_url', value: projectUrl, type: 'URL' }
          ]
        }
      ];

      // Add organization section if available
      if (orgId) {
        vercelSections.splice(1, 0, {
          label: 'Organization',
          fields: [
            { label: 'org_id', value: orgId, type: 'STRING' }
          ]
        });
      }

      opEnsureItemWithSections(vaultName, 'Vercel', vercelSections, undefined, verbose);

      if (verbose) {
        console.log(`  ✓ Wrote Vercel details to 1Password vault: ${vaultName}`);
      }
    } catch (e: any) {
      console.warn(`  Warning: Failed to write to 1Password: ${e?.message || e}`);
    }

    if (verbose) {
      console.log(`  ✓ Vercel project provisioned: ${vercelProjectName}`);
    } else {
      console.log(`  ✓ Vercel: ${vercelProjectName}`);
    }

    return {
      result: {
        project: {
          id: projectId,
          name: vercelProjectName,
          url: projectUrl
        }
      },
      rollbackActions
    };
  } catch (e: any) {
    throw new Error(`Vercel provisioning failed: ${e?.message || e}`);
  }
}

/**
 * List all Vercel projects for cleanup
 */
export async function listVercelInstances(
  options: { projectName?: string; envSuffix?: 'dev' | 'prod'; filterPattern?: string; verbose?: boolean }
): Promise<Array<{ id: string; name: string; environment?: 'dev' | 'prod' | 'unknown'; metadata?: any; createdAt?: string }>> {
  const { projectName, envSuffix, filterPattern, verbose } = options;

  // Get Vercel token
  const token = process.env.VERCEL_TOKEN;

  if (!token) {
    throw new Error('VERCEL_TOKEN not set. Add to .env file');
  }

  try {
    const resp = await retryFetch(
      'https://api.vercel.com/v9/projects',
      {
        headers: { 'Authorization': `Bearer ${token}` }
      },
      {
        maxRetries: 3,
        verbose: verbose
      }
    );

    const data: any = await resp.json();
    const projects = data?.projects || [];

    // Filter resources
    let matches = projects;

    if (filterPattern) {
      // Use custom filter pattern
      const pattern = filterPattern.toLowerCase();
      matches = matches.filter((proj: any) => {
        const name = (proj?.name || '').toLowerCase();
        return name.includes(pattern);
      });
    } else if (projectName) {
      // Filter by project name pattern
      const pattern = envSuffix
        ? `${projectName}-${envSuffix}`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-')
        : `${projectName}-`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-');

      matches = matches.filter((proj: any) => {
        const name = (proj?.name || '').toLowerCase();
        return envSuffix
          ? name === pattern
          : name.startsWith(pattern);
      });
    }
    // If neither filterPattern nor projectName: return all resources

    return matches.map((proj: any) => {
      const name = proj.name || proj.id;
      const env = name.endsWith('-dev') ? 'dev' as const
        : name.endsWith('-prod') ? 'prod' as const
        : 'unknown' as const;

      return {
        id: proj.id,
        name: proj.name,
        environment: env,
        metadata: {
          framework: proj.framework,
          link: proj.link
        },
        createdAt: proj.createdAt ? new Date(proj.createdAt).toISOString() : undefined
      };
    });
  } catch (error: any) {
    if (verbose) {
      console.warn(`  Warning: Failed to list Vercel projects: ${error?.message || error}`);
    }
    return [];
  }
}

/**
 * Delete a Vercel project by ID
 */
export async function deleteVercelInstance(
  instanceId: string,
  options: { verbose?: boolean }
): Promise<{ id: string; name: string; success: boolean; error?: string }> {
  const { verbose } = options;

  // Get Vercel token
  const token = process.env.VERCEL_TOKEN;

  if (!token) {
    return {
      id: instanceId,
      name: instanceId,
      success: false,
      error: 'VERCEL_TOKEN not set. Add to .env file'
    };
  }

  try {
    await retryFetch(
      `https://api.vercel.com/v9/projects/${instanceId}`,
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      },
      {
        maxRetries: 3,
        verbose: verbose
      }
    );

    if (verbose) {
      console.log(`    Deleted Vercel project ${instanceId}`);
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
