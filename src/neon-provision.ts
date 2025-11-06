/**
 * Neon provisioning (hosted Postgres)
 * - Creates a Neon project and captures a DATABASE_URL
 * - Writes secrets to the project's 1Password vault
 */

import { execSync } from 'node:child_process';
import { ensureOpAuth, opEnsureVault, opGetItem, opItemField, opReadRef, opReadField, opEnsureItemWithSections, ItemSection } from './op-util.js';
import { createApiClient, ContentType } from '@neondatabase/api-client';
import { ProvisionOptions, NeonResult } from './types.js';
import { createRollbackAction, RollbackAction } from './rollback.js';
import { getNeonCredentials, getMissingCredentialsMessage } from './credentials.js';

function sh(
  cmd: string,
  opts: { capture?: boolean; env?: Record<string, string>; verbose?: boolean } = {}
) {
  if (opts.capture) {
    return execSync(`${cmd} 2>&1`, {
      stdio: 'pipe',
      env: { ...process.env, ...(opts.env || {}) }
    }).toString();
  }
  if (opts.verbose) console.log(`$ ${cmd}`);
  execSync(cmd, {
    stdio: opts.verbose ? 'inherit' : 'ignore',
    env: { ...process.env, ...(opts.env || {}) }
  });
  return '';
}

async function neonApiRequest(
  api: ReturnType<typeof createApiClient>,
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: unknown
) {
  const resp = await api.request({
    path,
    method,
    body,
    type: body ? ContentType.Json : undefined,
  });
  return resp.data as any;
}

function pickConnectionString(obj: any): string {
  if (!obj || typeof obj !== 'object') return '';

  // Common response shapes
  const tryList = [
    obj?.connection_uri,
    obj?.connectionString,
    obj?.database_url,
    obj?.databaseUrl,
  ];
  for (const v of tryList) {
    if (typeof v === 'string' && v.includes('postgres')) return v;
  }

  // Look into arrays like connection_uris
  const arrays = [
    obj?.connection_uris,
    obj?.connectionUris,
    obj?.uris,
    obj?.endpoints,
    obj?.project?.connection_uris
  ];
  for (const arr of arrays) {
    if (Array.isArray(arr)) {
      for (const x of arr) {
        const s = pickConnectionString(x);
        if (s) return s;
      }
    }
  }

  // Nested project/branch structures
  const nested = [obj?.project, obj?.default_endpoint, obj?.branch];
  for (const n of nested) {
    const s = pickConnectionString(n);
    if (s) return s;
  }

  return '';
}

/**
 * Find an existing Neon project by name
 * @returns Project object with id and optional connection details, or null if not found
 */
async function findExistingProject(
  api: ReturnType<typeof createApiClient>,
  name: string,
  verbose?: boolean
): Promise<{ id: string; databaseUrl?: string } | null> {
  try {
    const list: any = await neonApiRequest(api, '/projects', 'GET');
    const arr = (list?.projects || list?.data || list) as any[];

    if (!Array.isArray(arr)) {
      return null;
    }

    const found = arr.find((p) => (p?.name || '').toLowerCase() === name.toLowerCase());

    if (found?.id) {
      if (verbose) {
        console.log(`  Found existing Neon project: ${found.name} (${found.id})`);
      }

      // Try to extract database URL from project data
      let databaseUrl = pickConnectionString(found) || '';

      // If not in list response, try fetching project details
      if (!databaseUrl) {
        try {
          const details = await neonApiRequest(api, `/projects/${found.id}`, 'GET');
          databaseUrl = pickConnectionString(details) || '';
        } catch (e: any) {
          if (verbose) {
            console.warn(`  Could not fetch project details: ${e?.message || e}`);
          }
        }
      }

      return {
        id: found.id,
        databaseUrl: databaseUrl || undefined
      };
    }

    return null;
  } catch (e: any) {
    if (verbose) {
      console.warn(`  Failed to check for existing projects: ${e?.message || e}`);
    }
    return null;
  }
}

/**
 * Provision a Neon PostgreSQL database
 */
export async function provisionNeon(
  options: ProvisionOptions
): Promise<{ result: NeonResult; rollbackActions: RollbackAction[] }> {
  const { projectName, envSuffix, verbose, dryRun } = options;
  const rollbackActions: RollbackAction[] = [];

  const name = `${projectName}-${envSuffix}`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-');
  const vaultName = name;

  if (verbose) {
    console.log(`  Neon project name: ${name}`);
  }

  if (dryRun) {
    console.log(`  [DRY RUN] Would create Neon project: ${name}`);
    return {
      result: {
        projectId: 'dry-run-project-id',
        databaseUrl: 'postgresql://dry-run:password@dry-run.neon.tech/neondb'
      },
      rollbackActions
    };
  }

  // Get credentials from master vault or environment variables
  const credentials = getNeonCredentials();
  const apiKey = credentials.apiKey;
  const orgId = credentials.orgId;
  const region = credentials.region || 'aws-us-east-1';

  if (!apiKey) {
    throw new Error(getMissingCredentialsMessage('neon'));
  }

  // Create project via official client
  let projectId = '';
  let databaseUrl = '';
  const api = createApiClient({ apiKey });

  // Check for existing project before attempting to create
  const existingProject = await findExistingProject(api, name, verbose);

  if (existingProject) {
    // Use existing project
    projectId = existingProject.id;
    databaseUrl = existingProject.databaseUrl || '';

    // If we couldn't get the database URL from API, try 1Password
    if (!databaseUrl) {
      try {
        ensureOpAuth();
        const vaultExists = opReadField(vaultName, 'Neon', 'Database', 'database_url');
        if (vaultExists) {
          databaseUrl = vaultExists;
          if (verbose) {
            console.log(`  Retrieved DATABASE_URL from 1Password vault: ${vaultName}`);
          }
        }
      } catch (e) {
        // Vault or field doesn't exist yet, that's ok
        if (verbose) {
          console.log(`  DATABASE_URL not found in 1Password, will attempt to fetch from Neon API`);
        }
      }
    }

    if (verbose) {
      console.log(`  ✓ Using existing Neon project: ${name}`);
    }

    // Note: No rollback action for existing projects since we didn't create them
  } else {
    // Project doesn't exist, create it
    if (verbose) {
      console.log(`  Creating new Neon project: ${name}`);
    }

    const attemptCreate = async () => {
    const proj: any = { name, region_id: region };
    if (orgId) proj.organization_id = orgId;
    const body: any = { project: proj };
    const created = await neonApiRequest(api, '/projects', 'POST', body);
    projectId = created?.project?.id || created?.id || '';
    databaseUrl = pickConnectionString(created) || '';
  };

  try {
    await attemptCreate();

    // Add rollback action to delete the project
    if (projectId) {
      rollbackActions.push(
        createRollbackAction(
          'neon',
          `Delete Neon project ${name} (${projectId})`,
          async () => {
            try {
              await neonApiRequest(api, `/projects/${projectId}`, 'DELETE');
              if (verbose) {
                console.log(`    Deleted Neon project ${projectId}`);
              }
            } catch (e: any) {
              console.warn(`    Failed to delete Neon project: ${e?.message || e}`);
            }
          }
        )
      );
    }
  } catch (e: any) {
    const msg = (e && e.response && e.response.data)
      ? JSON.stringify(e.response.data)
      : (e?.message || String(e));

    if (verbose) {
      console.warn(`  Neon project create failed: ${msg}`);
      console.log('  Retrying in 1.5s...');
    }

    await new Promise((r) => setTimeout(r, 1500));

    try {
      await attemptCreate();

      // Add rollback action
      if (projectId) {
        rollbackActions.push(
          createRollbackAction(
            'neon',
            `Delete Neon project ${name} (${projectId})`,
            async () => {
              try {
                await neonApiRequest(api, `/projects/${projectId}`, 'DELETE');
              } catch {
                // Ignore
              }
            }
          )
        );
      }
    } catch (e2: any) {
      const msg2 = (e2 && e2.response && e2.response.data)
        ? JSON.stringify(e2.response.data)
        : (e2?.message || String(e2));

      if (verbose) {
        console.warn(`  Retry failed: ${msg2}`);
      }

      // No fallback needed - we already checked for existing projects upfront
      throw new Error(`Failed to create Neon project: ${msg2}`);
    }
    }
  }

  // If we didn't get a URL, try to fetch connection URIs explicitly
  if (projectId && !databaseUrl) {
    try {
      const details = await neonApiRequest(api, `/projects/${projectId}`, 'GET');
      databaseUrl = pickConnectionString(details) || '';

      if (!databaseUrl) {
        const uris = await neonApiRequest(api, `/projects/${projectId}/connection_uris`, 'GET');
        databaseUrl = pickConnectionString(uris) || '';
      }
    } catch (e: any) {
      if (verbose) {
        console.warn(`  Failed to fetch connection URIs: ${e?.message || e}`);
      }
    }
  }

  if (!projectId) {
    throw new Error('Could not determine Neon project id (check API key and network access)');
  }

  if (!databaseUrl) {
    throw new Error('Could not determine DATABASE_URL (project may still be initializing)');
  }

  // Write to 1Password project vault
  try {
    ensureOpAuth();
    opEnsureVault(vaultName);

    // Extract postgres host from database URL
    let postgresHost = '';
    try {
      const u = new URL(databaseUrl);
      postgresHost = u.hostname;
    } catch {
      // Ignore
    }

    // Create Neon item with sections
    const neonSections: ItemSection[] = [
      {
        label: 'Database',
        fields: [
          { label: 'project_id', value: projectId, type: 'STRING' },
          { label: 'database_url', value: databaseUrl, type: 'CONCEALED' }
        ]
      }
    ];

    // Add Connection section if we have the host
    if (postgresHost) {
      neonSections.push({
        label: 'Connection',
        fields: [
          { label: 'postgres_host', value: postgresHost, type: 'STRING' }
        ]
      });
    }

    opEnsureItemWithSections(vaultName, 'Neon', neonSections, undefined, verbose);

    if (verbose) {
      console.log(`  ✓ Wrote Neon details to 1Password vault: ${vaultName}`);
    }
  } catch (e: any) {
    console.warn(`  Warning: Failed to write to 1Password: ${e?.message || e}`);
  }

  if (verbose) {
    console.log(`  ✓ Neon project provisioned: ${name}`);
  } else {
    console.log(`  ✓ Neon: ${name}`);
  }

  return {
    result: { projectId, databaseUrl },
    rollbackActions
  };
}

/**
 * List all Neon projects for cleanup
 */
export async function listNeonInstances(
  options: { projectName?: string; envSuffix?: 'dev' | 'prod'; filterPattern?: string; verbose?: boolean }
): Promise<Array<{ id: string; name: string; environment?: 'dev' | 'prod' | 'unknown'; metadata?: any; createdAt?: string }>> {
  const { projectName, envSuffix, filterPattern, verbose } = options;

  // Get credentials from master vault or environment variables
  const credentials = getNeonCredentials();
  const apiKey = credentials.apiKey;

  if (!apiKey) {
    throw new Error(getMissingCredentialsMessage('neon'));
  }

  const api = createApiClient({ apiKey });

  try {
    const list: any = await neonApiRequest(api, '/projects', 'GET');
    const arr = (list?.projects || list?.data || list) as any[];

    if (!Array.isArray(arr)) {
      return [];
    }

    // Filter resources
    let matches = arr;

    if (filterPattern) {
      // Use custom filter pattern
      const pattern = filterPattern.toLowerCase();
      matches = matches.filter(p => {
        const name = (p?.name || '').toLowerCase();
        return name.includes(pattern);
      });
    } else if (projectName) {
      // Filter by project name pattern
      const pattern = envSuffix
        ? `${projectName}-${envSuffix}`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-')
        : `${projectName}-`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-');

      matches = matches.filter(p => {
        const name = (p?.name || '').toLowerCase();
        return envSuffix
          ? name === pattern
          : name.startsWith(pattern);
      });
    }
    // If neither filterPattern nor projectName: return all resources

    return matches.map(p => {
      const name = p.name || p.id;
      const env = name.endsWith('-dev') ? 'dev' as const
        : name.endsWith('-prod') ? 'prod' as const
        : 'unknown' as const;

      return {
        id: p.id,
        name: p.name || p.id,
        environment: env,
        metadata: {
          region: p.region_id,
          platform: p.platform_id,
          branch: p.default_branch_id
        },
        createdAt: p.created_at
      };
    });
  } catch (error: any) {
    if (verbose) {
      console.warn(`  Warning: Failed to list Neon projects: ${error?.message || error}`);
    }
    return [];
  }
}

/**
 * Delete a Neon project by ID
 */
export async function deleteNeonInstance(
  instanceId: string,
  options: { verbose?: boolean }
): Promise<{ id: string; name: string; success: boolean; error?: string }> {
  const { verbose } = options;

  // Get credentials from master vault or environment variables
  const credentials = getNeonCredentials();
  const apiKey = credentials.apiKey;

  if (!apiKey) {
    return {
      id: instanceId,
      name: instanceId,
      success: false,
      error: getMissingCredentialsMessage('neon')
    };
  }

  const api = createApiClient({ apiKey });

  try {
    await neonApiRequest(api, `/projects/${instanceId}`, 'DELETE');

    if (verbose) {
      console.log(`    Deleted Neon project ${instanceId}`);
    }

    return {
      id: instanceId,
      name: instanceId,
      success: true
    };
  } catch (error: any) {
    const msg = (error && error.response && error.response.data)
      ? JSON.stringify(error.response.data)
      : (error?.message || String(error));

    return {
      id: instanceId,
      name: instanceId,
      success: false,
      error: msg
    };
  }
}
