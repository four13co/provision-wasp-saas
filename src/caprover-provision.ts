/**
 * CapRover provisioning (backend hosting)
 * - Creates a CapRover app
 * - Enables HTTPS
 * - Generates app deploy token
 * - Writes secrets to 1Password vault
 */

import { execSync } from 'node:child_process';
import { ensureOpAuth, opGetItem, opItemField, opEnsureVault, opReadRef } from './op-util.js';
import { ProvisionOptions, CapRoverResult } from './types.js';
import { createRollbackAction, RollbackAction } from './rollback.js';

function sh(cmd: string, verbose?: boolean) {
  if (verbose) console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: verbose ? 'inherit' : 'ignore' });
}

function apiBase(u: string) {
  const trimmed = u.replace(/\/$/, '');
  return trimmed.includes('/api/') ? trimmed : trimmed + '/api/v2';
}

/**
 * Provision a CapRover backend application
 */
export async function provisionCapRover(
  options: ProvisionOptions
): Promise<{ result: CapRoverResult; rollbackActions: RollbackAction[] }> {
  const { projectName, envSuffix, verbose, dryRun } = options;
  const rollbackActions: RollbackAction[] = [];

  const appName = `${projectName}-api-${envSuffix}`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-');
  const vaultName = `${projectName}-${envSuffix}`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-');

  if (verbose) {
    console.log(`  CapRover app name: ${appName}`);
  }

  if (dryRun) {
    console.log(`  [DRY RUN] Would create CapRover app: ${appName}`);
    return {
      result: {
        appName,
        appToken: 'dry-run-token',
        apiUrl: `https://${appName}.example.com`
      },
      rollbackActions
    };
  }

  // Get CapRover credentials from environment variables
  const url = process.env.CAPROVER_URL;
  const password = process.env.CAPROVER_PASSWORD;

  if (!url) {
    throw new Error('CAPROVER_URL not set. Add to .env file:\n  CAPROVER_URL=your-value\n\nOr use 1Password references with:\n  op run --env-file=".env" -- npx provision-wasp-saas ...');
  }

  if (!password) {
    throw new Error('CAPROVER_PASSWORD not set. Add to .env file:\n  CAPROVER_PASSWORD=your-value\n\nOr use 1Password references with:\n  op run --env-file=".env" -- npx provision-wasp-saas ...');
  }

  const base = apiBase(url);
  let appToken = '';
  let apiUrl = '';

  try {
    // Login to CapRover API
    let res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-namespace': 'captain' },
      body: new URLSearchParams({ password })
    });

    const login = await res.json().catch(() => ({} as any)) as any;
    const token = login?.data?.token;

    if (!token) {
      throw new Error('Failed to authenticate with CapRover API');
    }

    // Register app
    res = await fetch(`${base}/user/apps/appDefinitions/register/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-namespace': 'captain', 'x-captain-auth': token },
      body: JSON.stringify({ appName })
    });

    if (!res.ok) {
      // Try alternative path variant
      res = await fetch(`${base}/user/apps/appDefinitions/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-namespace': 'captain', 'x-captain-auth': token },
        body: JSON.stringify({ appName })
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw new Error(`Failed to register CapRover app: ${res.status} ${errorText}`);
      }
    }

    if (verbose) {
      console.log(`  ✓ Registered CapRover app: ${appName}`);
    }

    // Add rollback action to delete the app
    rollbackActions.push(
      createRollbackAction(
        'caprover',
        `Delete CapRover app ${appName}`,
        async () => {
          try {
            await fetch(`${base}/user/apps/appDefinitions/delete/`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-namespace': 'captain', 'x-captain-auth': token },
              body: JSON.stringify({ appName })
            });
            if (verbose) {
              console.log(`    Deleted CapRover app ${appName}`);
            }
          } catch (e: any) {
            console.warn(`    Failed to delete CapRover app: ${e?.message || e}`);
          }
        }
      )
    );

    // Enable HTTPS for the app's base domain
    try {
      const candidates = [
        '/user/apps/appDefinitions/enablebasedomainssl',
        '/user/appDefinitions/enablessl',
        '/user/appDefinitions/enablehttps',
        '/user/appDefinitions/enableHttps',
        '/user/apps/appDefinitions/enablessl',
        '/user/apps/appDefinitions/enablehttps',
        '/user/apps/appDefinitions/enableHttps'
      ];

      let success = false;

      for (const p of candidates) {
        for (const suffix of ['/', '']) {
          const path = `${p}${suffix}`;
          const r = await fetch(`${base}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-namespace': 'captain', 'x-captain-auth': token },
            body: JSON.stringify({ appName })
          });

          const txt = await r.text().catch(() => '');

          if (r.ok) {
            try {
              const json = JSON.parse(txt);
              const st = json?.status || json?.data?.status;
              if (st === 100 || json?.status === 'OK') {
                success = true;
                break;
              }
            } catch {
              // Non-JSON but 200 OK; consider success
              success = true;
              break;
            }
          }
        }
        if (success) break;
      }

      if (success && verbose) {
        console.log(`  ✓ HTTPS enabled for ${appName}`);
      } else if (!success) {
        console.warn(`  Warning: Could not enable HTTPS for ${appName}`);
      }
    } catch (e: any) {
      console.warn(`  Warning: Could not enable HTTPS: ${e?.message || e}`);
    }

    // Enable app deploy token via update endpoint
    try {
      const defs1 = await fetch(`${base}/user/apps/appDefinitions/`, {
        headers: { 'x-namespace': 'captain', 'x-captain-auth': token }
      });

      const defsJson1 = defs1.ok ? await defs1.json().catch(() => null) : null as any;
      const list = defsJson1?.data?.appDefinitions || [];
      const current = list.find((d: any) => (d?.appName || '').toLowerCase() === appName.toLowerCase());

      if (current) {
        const body: any = {
          appName,
          projectId: current.projectId || '',
          description: current.description || '',
          instanceCount: current.instanceCount ?? 1,
          captainDefinitionRelativeFilePath: current.captainDefinitionRelativeFilePath || 'captain-definition',
          envVars: current.envVars || [],
          volumes: current.volumes || [],
          tags: current.tags || [],
          nodeId: current.nodeId || '',
          notExposeAsWebApp: !!current.notExposeAsWebApp,
          containerHttpPort: current.containerHttpPort || 80,
          httpAuth: current.httpAuth || undefined,
          forceSsl: !!current.forceSsl,
          ports: current.ports || [],
          appPushWebhook: current.appPushWebhook ? { repoInfo: current.appPushWebhook.repoInfo || {} } : undefined,
          customNginxConfig: current.customNginxConfig || '',
          redirectDomain: current.redirectDomain || '',
          preDeployFunction: current.preDeployFunction || '',
          serviceUpdateOverride: current.serviceUpdateOverride || '',
          websocketSupport: !!current.websocketSupport,
          appDeployTokenConfig: { enabled: true }
        };

        await fetch(`${base}/user/apps/appDefinitions/update/`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-namespace': 'captain', 'x-captain-auth': token },
          body: JSON.stringify(body)
        });
      }

      // Fetch updated definitions to get the token
      const defs2 = await fetch(`${base}/user/apps/appDefinitions/`, {
        headers: { 'x-namespace': 'captain', 'x-captain-auth': token }
      });

      const defsJson2 = defs2.ok ? await defs2.json().catch(() => null) : null as any;
      const list2 = defsJson2?.data?.appDefinitions || [];
      const after = list2.find((d: any) => (d?.appName || '').toLowerCase() === appName.toLowerCase());
      appToken = after?.appDeployTokenConfig?.appDeployToken || '';

      if (appToken && verbose) {
        console.log(`  ✓ Generated app deploy token`);
      }
    } catch (e: any) {
      if (verbose) {
        console.warn(`  Warning: Could not generate app token: ${e?.message || e}`);
      }
    }

    // Compute API URL
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^captain\./, '');
      apiUrl = `https://${appName}.${host}`;
    } catch (e: any) {
      if (verbose) {
        console.warn(`  Warning: Could not compute API URL: ${e?.message || e}`);
      }
    }

    // Write to 1Password project vault
    try {
      ensureOpAuth();
      opEnsureVault(vaultName);

      const put = (title: string, field: 'username' | 'password', value: string) => {
        if (!value) return;
        try {
          sh(`op item get --vault "${vaultName}" "${title}"`, verbose);
        } catch {
          sh(`op item create --vault "${vaultName}" --category=LOGIN --title "${title}" --url=local`, verbose);
        }
        const esc = value.replace(/'/g, "'\\''");
        sh(`op item edit --vault "${vaultName}" "${title}" ${field}='${esc}'`, verbose);
      };

      put('CAPROVER_URL', 'username', url);
      put('CAPROVER_APP_NAME', 'username', appName);
      if (appToken) put('CAPROVER_APP_TOKEN', 'password', appToken);
      if (apiUrl) put('API_URL', 'username', apiUrl);

      if (verbose) {
        console.log(`  ✓ Wrote CapRover details to 1Password vault: ${vaultName}`);
      }
    } catch (e: any) {
      console.warn(`  Warning: Failed to write to 1Password: ${e?.message || e}`);
    }

    if (!appToken) {
      console.warn(`  Warning: App token not generated. Create manually in CapRover UI and add to vault as CAPROVER_APP_TOKEN.`);
    }

    if (verbose) {
      console.log(`  ✓ CapRover app provisioned: ${appName}`);
    } else {
      console.log(`  ✓ CapRover: ${appName}`);
    }

    return {
      result: {
        appName,
        appToken: appToken || '',
        apiUrl
      },
      rollbackActions
    };
  } catch (e: any) {
    throw new Error(`CapRover provisioning failed: ${e?.message || e}`);
  }
}

/**
 * List all CapRover apps for cleanup
 */
export async function listCapRoverInstances(
  options: { projectName?: string; envSuffix?: 'dev' | 'prod'; filterPattern?: string; verbose?: boolean }
): Promise<Array<{ id: string; name: string; environment?: 'dev' | 'prod' | 'unknown'; metadata?: any; createdAt?: string }>> {
  const { projectName, envSuffix, filterPattern, verbose } = options;

  // Get CapRover credentials
  const url = process.env.CAPROVER_URL;
  const password = process.env.CAPROVER_PASSWORD;

  if (verbose) {
    console.log(`  Debug: CAPROVER_URL is ${url ? 'set' : 'NOT SET'}`);
    console.log(`  Debug: CAPROVER_PASSWORD is ${password ? 'set' : 'NOT SET'}`);
  }

  if (!url) {
    throw new Error('CAPROVER_URL not set. Add to .env file');
  }

  if (!password) {
    throw new Error('CAPROVER_PASSWORD not set. Add to .env file');
  }

  const base = url.endsWith('/') ? url.slice(0, -1) : url;

  if (verbose) {
    console.log(`  Debug: Connecting to CapRover at ${base}`);
  }

  try {
    // Login
    const loginResp = await fetch(`${base}/api/v2/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-namespace': 'captain' },
      body: JSON.stringify({ password })
    });

    if (verbose) {
      console.log(`  Debug: Login response status: ${loginResp.status}`);
    }

    const loginData: any = loginResp.ok ? await loginResp.json() : null;
    const token = loginData?.data?.token;

    if (!token) {
      throw new Error('Failed to authenticate with CapRover');
    }

    if (verbose) {
      console.log(`  Debug: Authentication successful`);
    }

    // List apps - try different API path variations
    let appsResp: Response;
    let appsData: any = null;

    // Try v2 API first
    appsResp = await fetch(`${base}/api/v2/user/apps/appDefinitions`, {
      headers: { 'x-namespace': 'captain', 'x-captain-auth': token }
    });

    if (verbose) {
      console.log(`  Debug: Apps list response status (v2): ${appsResp.status}`);
    }

    if (!appsResp.ok) {
      // Fall back to non-versioned API
      appsResp = await fetch(`${base}/user/apps/appDefinitions`, {
        headers: { 'x-namespace': 'captain', 'x-captain-auth': token }
      });

      if (verbose) {
        console.log(`  Debug: Apps list response status (non-versioned): ${appsResp.status}`);
      }
    }

    appsData = appsResp.ok ? await appsResp.json() : null;
    const apps = appsData?.data?.appDefinitions || [];

    if (verbose) {
      console.log(`  Debug: Found ${apps.length} total apps on CapRover`);
      if (apps.length > 0) {
        console.log(`  Debug: App names: ${apps.map((a: any) => a.appName).join(', ')}`);
      }
    }

    // Filter resources
    let matches = apps;

    if (filterPattern) {
      // Use custom filter pattern
      const pattern = filterPattern.toLowerCase();
      matches = matches.filter((app: any) => {
        const name = (app?.appName || '').toLowerCase();
        return name.includes(pattern);
      });
    } else if (projectName) {
      // Filter by project name pattern
      const pattern = envSuffix
        ? `${projectName}-${envSuffix}`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-')
        : `${projectName}-`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-');

      matches = matches.filter((app: any) => {
        const name = (app?.appName || '').toLowerCase();
        return envSuffix
          ? name === pattern
          : name.startsWith(pattern);
      });
    }
    // If neither filterPattern nor projectName: return all resources

    return matches.map((app: any) => {
      const name = app.appName || app.id;
      const env = name.endsWith('-dev') ? 'dev' as const
        : name.endsWith('-prod') ? 'prod' as const
        : 'unknown' as const;

      return {
        id: app.appName, // CapRover uses appName as ID
        name: app.appName,
        environment: env,
        metadata: {
          instanceCount: app.instanceCount,
          notExposeAsWebApp: app.notExposeAsWebApp,
          hasPersistentData: app.hasPersistentData
        }
      };
    });
  } catch (error: any) {
    if (verbose) {
      console.warn(`  Warning: Failed to list CapRover apps: ${error?.message || error}`);
    }
    return [];
  }
}

/**
 * Delete a CapRover app by name
 */
export async function deleteCapRoverInstance(
  instanceId: string,
  options: { verbose?: boolean }
): Promise<{ id: string; name: string; success: boolean; error?: string }> {
  const { verbose } = options;

  // Get CapRover credentials
  const url = process.env.CAPROVER_URL;
  const password = process.env.CAPROVER_PASSWORD;

  if (!url) {
    return {
      id: instanceId,
      name: instanceId,
      success: false,
      error: 'CAPROVER_URL not set. Add to .env file'
    };
  }

  if (!password) {
    return {
      id: instanceId,
      name: instanceId,
      success: false,
      error: 'CAPROVER_PASSWORD not set. Add to .env file'
    };
  }

  const base = url.endsWith('/') ? url.slice(0, -1) : url;

  try {
    // Login
    const loginResp = await fetch(`${base}/api/v2/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-namespace': 'captain' },
      body: JSON.stringify({ password })
    });

    const loginData: any = loginResp.ok ? await loginResp.json() : null;
    const token = loginData?.data?.token;

    if (!token) {
      return {
        id: instanceId,
        name: instanceId,
        success: false,
        error: 'Failed to authenticate with CapRover'
      };
    }

    // Delete app
    const deleteResp = await fetch(`${base}/user/apps/appDefinitions/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-namespace': 'captain', 'x-captain-auth': token },
      body: JSON.stringify({ appName: instanceId })
    });

    if (!deleteResp.ok) {
      const errorData: any = await deleteResp.json().catch(() => ({}));
      return {
        id: instanceId,
        name: instanceId,
        success: false,
        error: errorData?.message || `HTTP ${deleteResp.status}`
      };
    }

    if (verbose) {
      console.log(`    Deleted CapRover app ${instanceId}`);
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
