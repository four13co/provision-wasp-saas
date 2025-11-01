/**
 * Neon provisioning (hosted Postgres)
 * - Creates a Neon project and captures a DATABASE_URL
 * - Writes secrets to the project's 1Password vault
 */

import { execSync } from 'node:child_process';
import { ensureOpAuth, opEnsureVault, opGetItem, opItemField, opReadRef } from './op-util.js';
import { createApiClient, ContentType } from '@neondatabase/api-client';
import { ProvisionOptions, NeonResult } from './types.js';
import { createRollbackAction, RollbackAction } from './rollback.js';

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

  // Resolve Neon API key and optional org id
  const apiKey = process.env.NEON_API_KEY;
  const orgId = process.env.NEON_ORG_ID;

  if (!apiKey) {
    throw new Error('NEON_API_KEY not set. Add to .env file:\n  NEON_API_KEY=your-value\n\nOr use 1Password references with:\n  op run --env-file=".env" -- npx provision-wasp-saas ...');
  }

  const region = process.env.NEON_REGION || 'aws-us-east-1';

  // Create project via official client
  let projectId = '';
  let databaseUrl = '';
  const api = createApiClient({ apiKey });

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
        console.log('  Attempting to find existing project...');
      }

      // Fallback: try to find an existing project by name
      try {
        const list: any = await neonApiRequest(api, '/projects', 'GET');
        const arr = (list?.projects || list?.data || list) as any[];
        const found = Array.isArray(arr)
          ? arr.find((p) => (p?.name || '').toLowerCase() === name.toLowerCase())
          : null;

        if (found?.id) {
          projectId = found.id;
          if (verbose) {
            console.log(`  Found existing project: ${projectId}`);
          }
        }
      } catch {
        // Ignore
      }

      if (!projectId) {
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

    const put = (title: string, field: 'username' | 'password', value: string) => {
      if (!value) return;
      try {
        sh(`op item get --vault "${vaultName}" "${title}"`, { verbose });
      } catch {
        sh(`op item create --vault "${vaultName}" --category=LOGIN --title "${title}" --url=local`, { verbose });
      }
      const esc = value.replace(/'/g, "'\\''");
      sh(`op item edit --vault "${vaultName}" "${title}" ${field}='${esc}'`, { verbose });
    };

    put('NEON_PROJECT_ID', 'username', projectId);
    put('DATABASE_URL', 'password', databaseUrl);

    try {
      const u = new URL(databaseUrl);
      put('POSTGRES_HOST', 'username', u.hostname);
    } catch {
      // Ignore
    }

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

  // Get API key
  const apiKey = process.env.NEON_API_KEY;

  if (!apiKey) {
    throw new Error('NEON_API_KEY not set. Add to .env file');
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

  // Get API key
  const apiKey = process.env.NEON_API_KEY;

  if (!apiKey) {
    return {
      id: instanceId,
      name: instanceId,
      success: false,
      error: 'NEON_API_KEY not set. Add to .env file'
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
