/**
 * CapRover provisioning (backend hosting)
 * - Creates a CapRover app
 * - Enables HTTPS
 * - Generates app deploy token
 * - Writes secrets to 1Password vault
 */

import { execSync } from 'node:child_process';
import { ensureOpAuth, opGetItem, opItemField, opEnsureVault, opReadRef, opEnsureItemWithSections, ItemSection, ItemField, opReadField } from './op-util.js';
import { ProvisionOptions, CapRoverResult } from './types.js';
import { createRollbackAction, RollbackAction } from './rollback.js';
import { getCapRoverCredentials, getMissingCredentialsMessage } from './credentials.js';
import { retry } from './retry-util.js';
import { createServiceAccount } from './service-account.js';

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
  const { projectName, envSuffix, verbose, dryRun, force = false } = options;
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

  // Get credentials from master vault or environment variables
  const credentials = getCapRoverCredentials();
  const url = credentials.url;
  const password = credentials.password;

  if (!url) {
    throw new Error(getMissingCredentialsMessage('caprover') + '\nSpecifically missing: CAPROVER_URL');
  }

  if (!password) {
    throw new Error(getMissingCredentialsMessage('caprover') + '\nSpecifically missing: CAPROVER_PASSWORD');
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

    // Check if app already exists
    const defsRes = await fetch(`${base}/user/apps/appDefinitions/`, {
      headers: { 'x-namespace': 'captain', 'x-captain-auth': token }
    });

    const defsJson = defsRes.ok ? await defsRes.json().catch(() => null) : null as any;
    const existingApps = defsJson?.data?.appDefinitions || [];
    const existingApp = existingApps.find((a: any) => (a?.appName || '').toLowerCase() === appName.toLowerCase());

    if (existingApp) {
      // App already exists - retrieve its details
      appToken = existingApp?.appDeployTokenConfig?.appDeployToken || '';

      try {
        const u = new URL(url);
        const host = u.hostname.replace(/^captain\./, '');
        apiUrl = `https://${appName}.${host}`;
      } catch (e: any) {
        if (verbose) {
          console.warn(`  Warning: Could not compute API URL: ${e?.message || e}`);
        }
      }

      if (verbose) {
        console.log(`  ✓ CapRover app already exists: ${appName}`);
      }

      // Skip to vault writing and service account setup
    } else {
    // Register app with retry logic for 429 "operation in progress" errors
    const maxRetries = 3;
    let registrationSuccess = false;

    for (let attempt = 0; attempt < maxRetries && !registrationSuccess; attempt++) {
      try {
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
        }

        if (!res.ok) {
          const errorText = await res.text().catch(() => '');

          // Check for 429 "operation in progress" error
          if (res.status === 429 && errorText.toLowerCase().includes('operation still in progress')) {
            if (attempt < maxRetries - 1) {
              const waitSeconds = 90;
              if (verbose) {
                console.log(`  ⚠️  CapRover operation in progress, waiting ${waitSeconds} seconds before retry...`);
              } else {
                console.log(`  ⏳ Waiting for CapRover operation to complete (${waitSeconds}s)...`);
              }

              // Wait 90 seconds before retrying
              await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
              continue; // Retry
            } else {
              throw new Error(`Failed to register CapRover app after ${maxRetries} attempts: ${res.status} ${errorText}`);
            }
          } else {
            // Other error, don't retry
            throw new Error(`Failed to register CapRover app: ${res.status} ${errorText}`);
          }
        }

        registrationSuccess = true;
      } catch (error: any) {
        if (attempt === maxRetries - 1) {
          throw error;
        }
        // If it's a fetch error (not HTTP error), retry after 5 seconds
        if (verbose) {
          console.log(`  ⚠️  Registration attempt ${attempt + 1}/${maxRetries} failed: ${error.message}`);
          console.log(`  🔄 Retrying in 5 seconds...`);
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    if (verbose) {
      console.log(`  ✓ Registered CapRover app: ${appName}`);
    }

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

      // Add rollback action only for newly created apps
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
    } // End of "else" block for new app creation

    // Create service account and set CapRover environment variables
    let serviceAccountToken = '';
    let serviceAccountName = '';

    try {
      // Check if service account already exists for this environment
      ensureOpAuth();
      opEnsureVault(vaultName);

      const existingServiceAccountName = opReadField(vaultName, 'CapRover', 'ServiceAccount', 'service_account_name');

      if (existingServiceAccountName && !force) {
        if (verbose) {
          console.log(`  ✓ Service account already exists: ${existingServiceAccountName}`);
        }
        serviceAccountName = existingServiceAccountName;

        // Retrieve the token from vault for env var setting
        const existingToken = opReadField(vaultName, 'CapRover', 'ServiceAccount', 'token');
        if (existingToken) {
          serviceAccountToken = existingToken;
          if (verbose) {
            console.log(`  ✓ Retrieved service account token from vault`);
          }
        } else {
          console.warn(`  Warning: Service account exists but token not found in vault`);
          console.warn(`  You may need to manually set OP_SERVICE_ACCOUNT_TOKEN in CapRover`);
        }
      } else {
        // Create new service account (or force recreation)
        if (existingServiceAccountName && force) {
          console.log(`  🔄 Force mode: Recreating service account (old: ${existingServiceAccountName})`);
        } else if (verbose) {
          console.log(`  Creating service account for CapRover...`);
        }

        const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').substring(0, 14);
        serviceAccountName = `${projectName}-sa-${envSuffix}-caprover-v${timestamp}`;

        const serviceAccount = await createServiceAccount({
          name: serviceAccountName,
          vault: vaultName,
          permissions: ['read_items'],
          verbose
        });

        serviceAccountToken = serviceAccount.token;

        if (verbose) {
          console.log(`  ✓ Service account created: ${serviceAccountName}`);
        }
      }
    } catch (e: any) {
      console.warn(`  Warning: Failed to setup service account: ${e?.message || e}`);
      console.warn(`  CapRover app created but won't have 1Password integration`);
    }

    // Set CapRover environment variables (always attempt if we have the token)
    if (serviceAccountToken) {
      try {
        if (verbose) {
          console.log(`  Setting CapRover environment variables...`);
        }

        // Read GitHub credentials from vault for GHCR authentication
        let githubPat: string | null = null;
        let githubUsername: string | null = null;
        try {
          githubPat = opReadField(vaultName, 'GitHub', 'Credentials', 'pat');
          githubUsername = opReadField(vaultName, 'GitHub', 'Registry', 'username');
        } catch (e: any) {
          if (verbose) {
            console.log(`  Note: GitHub credentials not found in vault (${e?.message || e})`);
            console.log(`  Skipping GITHUB_PAT and GITHUB_USERNAME env vars`);
          }
        }

        // Build env vars array
        const envVars: Array<{ key: string; value: string }> = [
          { key: 'OP_SERVICE_ACCOUNT_TOKEN', value: serviceAccountToken },
          { key: 'OP_VAULT', value: vaultName }
        ];

        // Add GitHub credentials if available
        if (githubPat && githubUsername) {
          envVars.push(
            { key: 'GITHUB_PAT', value: githubPat },
            { key: 'GITHUB_USERNAME', value: githubUsername }
          );
          if (verbose) {
            console.log(`  Including GitHub credentials for GHCR authentication`);
          }
        }

        // Wait a moment for CapRover to fully initialize the app before setting env vars
        if (!existingApp) {
          if (verbose) {
            console.log(`  Waiting 5 seconds for CapRover app initialization...`);
          }
          await new Promise(resolve => setTimeout(resolve, 5000));
        }

        await updateCapRoverEnvVars(
          appName,
          envVars,
          { url, password, verbose }
        );

        // Verify env vars were set by reading them back
        try {
          const { getCapRoverCredentials } = await import('./credentials.js');
          const credentials = url && password
            ? { url, password }
            : getCapRoverCredentials();

          const verifyUrl = credentials.url ?? '';
          const verifyPassword = credentials.password ?? '';

          if (!verifyUrl || !verifyPassword) {
            throw new Error('Missing credentials for verification');
          }

          const base = apiBase(verifyUrl);

          // Login
          const loginRes = await fetch(`${base}/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-namespace': 'captain' },
            body: new URLSearchParams({ password: verifyPassword })
          });
          const loginJson = await loginRes.json().catch(() => ({} as any)) as any;
          const token = loginJson?.data?.token;

          if (token) {
            // Get app definition
            const defsRes = await fetch(`${base}/user/apps/appDefinitions/`, {
              headers: { 'x-namespace': 'captain', 'x-captain-auth': token }
            });
            const defsJson = await defsRes.json().catch(() => null) as any;
            const apps = defsJson?.data?.appDefinitions || [];
            const app = apps.find((a: any) => (a?.appName || '').toLowerCase() === appName.toLowerCase());

            if (app && app.envVars) {
              const hasOpToken = app.envVars.some((ev: any) => ev.key === 'OP_SERVICE_ACCOUNT_TOKEN');
              const hasOpVault = app.envVars.some((ev: any) => ev.key === 'OP_VAULT');
              const hasGithubPat = app.envVars.some((ev: any) => ev.key === 'GITHUB_PAT');
              const hasGithubUsername = app.envVars.some((ev: any) => ev.key === 'GITHUB_USERNAME');

              const requiredVarsSet = hasOpToken && hasOpVault;
              const githubVarsSet = hasGithubPat && hasGithubUsername;
              const githubVarsExpected = githubPat && githubUsername;

              if (requiredVarsSet) {
                if (githubVarsExpected && githubVarsSet) {
                  console.log(`  ✓ CapRover environment variables verified (including GitHub credentials)`);
                } else if (githubVarsExpected && !githubVarsSet) {
                  console.warn(`  ⚠️  Required vars set but GitHub credentials missing in CapRover`);
                } else {
                  console.log(`  ✓ CapRover environment variables verified`);
                }
              } else {
                console.warn(`  ⚠️  Environment variables partially set (OP_TOKEN: ${hasOpToken}, OP_VAULT: ${hasOpVault})`);
              }
            }
          }
        } catch (verifyError: any) {
          // Verification failed, but env vars might still be set
          if (verbose) {
            console.log(`  ✓ CapRover environment variables set (verification skipped: ${verifyError.message})`);
          } else {
            console.log(`  ✓ CapRover environment variables set`);
          }
        }
      } catch (e: any) {
        // Always show this warning, not just in verbose mode
        console.warn(`  ⚠️  Failed to set CapRover env vars: ${e?.message || e}`);
        console.warn(`  Please manually set these in CapRover dashboard:`);
        console.warn(`    - OP_SERVICE_ACCOUNT_TOKEN`);
        console.warn(`    - OP_VAULT=${vaultName}`);
      }
    } else if (serviceAccountName) {
      // Service account exists but we don't have the token
      console.warn(`  ⚠️  Service account exists but token not available`);
      console.warn(`  Please verify OP_SERVICE_ACCOUNT_TOKEN is set in CapRover`);
    }

    // Write to 1Password project vault
    try {
      ensureOpAuth();
      opEnsureVault(vaultName);

      // Create CapRover item with sections
      const caproverSections: ItemSection[] = [
        {
          label: 'Application',
          fields: [
            { label: 'app_name', value: appName, type: 'STRING' }
          ]
        },
        {
          label: 'Server',
          fields: [
            { label: 'url', value: url, type: 'URL' }
          ]
        }
      ];

      // Add deployment token if available
      if (appToken) {
        caproverSections.push({
          label: 'Deployment',
          fields: [
            { label: 'app_token', value: appToken, type: 'CONCEALED' }
          ]
        });
      }

      // Add API URL if available
      if (apiUrl) {
        caproverSections.push({
          label: 'URLs',
          fields: [
            { label: 'api_url', value: apiUrl, type: 'URL' }
          ]
        });
      }

      // Add service account metadata if available
      if (serviceAccountName) {
        const serviceAccountFields: ItemField[] = [
          { label: 'service_account_name', value: serviceAccountName, type: 'STRING' },
          { label: 'created_at', value: new Date().toISOString(), type: 'STRING' }
        ];

        // Add token if we just created the service account
        if (serviceAccountToken) {
          serviceAccountFields.push({
            label: 'token',
            value: serviceAccountToken,
            type: 'CONCEALED'
          });
        }

        caproverSections.push({
          label: 'ServiceAccount',
          fields: serviceAccountFields
        });
      }

      opEnsureItemWithSections(vaultName, 'CapRover', caproverSections, undefined, verbose);

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
 * Update environment variables for a CapRover app
 */
export async function updateCapRoverEnvVars(
  appName: string,
  envVars: Array<{ key: string; value: string }>,
  options: { url?: string; password?: string; verbose?: boolean } = {}
): Promise<void> {
  const { verbose } = options;

  // Get credentials from options or environment
  const credentials = options.url && options.password
    ? { url: options.url, password: options.password }
    : getCapRoverCredentials();

  const url = credentials.url;
  const password = credentials.password;

  if (!url) {
    throw new Error('CapRover URL not provided');
  }

  if (!password) {
    throw new Error('CapRover password not provided');
  }

  const base = apiBase(url);

  // Retry logic for env var updates
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Login to CapRover API
      const res = await fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-namespace': 'captain' },
        body: new URLSearchParams({ password })
      });

      const login = await res.json().catch(() => ({} as any)) as any;
      const token = login?.data?.token;

      if (!token) {
        throw new Error('Failed to authenticate with CapRover API');
      }

      // Get current app definition
      const defs = await fetch(`${base}/user/apps/appDefinitions/`, {
        headers: { 'x-namespace': 'captain', 'x-captain-auth': token }
      });

      const defsJson = defs.ok ? await defs.json().catch(() => null) : null as any;
      const list = defsJson?.data?.appDefinitions || [];
      const current = list.find((d: any) => (d?.appName || '').toLowerCase() === appName.toLowerCase());

      if (!current) {
        throw new Error(`App '${appName}' not found in CapRover`);
      }

      // Merge new environment variables with existing ones
      const existingEnvVars = current.envVars || [];
      const updatedEnvVars = [...existingEnvVars];

      // Update or add each environment variable
      for (const { key, value } of envVars) {
        const existingIndex = updatedEnvVars.findIndex((ev: any) => ev.key === key);
        if (existingIndex >= 0) {
          updatedEnvVars[existingIndex].value = value;
          if (verbose) {
            console.log(`  Updated env var: ${key}`);
          }
        } else {
          updatedEnvVars.push({ key, value });
          if (verbose) {
            console.log(`  Added env var: ${key}`);
          }
        }
      }

      // Update app definition with new environment variables
      const body: any = {
        appName,
        projectId: current.projectId || '',
        description: current.description || '',
        instanceCount: current.instanceCount ?? 1,
        captainDefinitionRelativeFilePath: current.captainDefinitionRelativeFilePath || 'captain-definition',
        envVars: updatedEnvVars,
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
        appDeployTokenConfig: current.appDeployTokenConfig || { enabled: false }
      };

      const updateRes = await fetch(`${base}/user/apps/appDefinitions/update/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-namespace': 'captain', 'x-captain-auth': token },
        body: JSON.stringify(body)
      });

      if (!updateRes.ok) {
        const errorText = await updateRes.text().catch(() => '');
        throw new Error(`Failed to update app: ${updateRes.status} ${errorText}`);
      }

      if (verbose) {
        console.log(`  ✓ Updated environment variables for ${appName}`);
      }

      // Success - exit retry loop
      return;
    } catch (e: any) {
      lastError = e;

      // Don't retry on last attempt
      if (attempt === maxRetries - 1) {
        break;
      }

      // Retry after a delay
      const delaySeconds = 10;
      if (verbose) {
        console.log(`  ⚠️  Env var update attempt ${attempt + 1}/${maxRetries} failed: ${e?.message || e}`);
        console.log(`  🔄 Retrying in ${delaySeconds} seconds...`);
      }
      await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    }
  }

  // All retries exhausted
  throw new Error(`Failed to update CapRover env vars: ${lastError?.message || lastError}`);
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
