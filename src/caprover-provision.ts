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
 * Resilient fetch wrapper for CapRover API calls
 * Handles EPIPE errors (broken pipe) caused by connection reuse issues
 * Automatically retries with exponential backoff and prevents connection pooling
 */
async function capRoverFetch(
  url: string,
  options: RequestInit = {},
  retries = 3,
  verbose = false
): Promise<Response> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fetch(url, {
        ...options,
        headers: {
          ...(options.headers || {}),
          'Connection': 'close' // Prevent connection reuse that causes EPIPE
        }
      });
    } catch (error: any) {
      // Check for EPIPE error (broken pipe)
      const isEPIPE = error?.cause?.code === 'EPIPE' ||
                       error?.code === 'EPIPE' ||
                       error?.message?.includes('EPIPE');

      if (isEPIPE && attempt < retries - 1) {
        const delayMs = 1000 * (attempt + 1); // Exponential backoff: 1s, 2s, 3s
        if (verbose) {
          console.log(`  ⚠️  Connection error (EPIPE), retrying in ${delayMs/1000}s... (attempt ${attempt + 1}/${retries})`);
        }
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue; // Retry
      }

      // Not EPIPE or out of retries - propagate error
      throw error;
    }
  }

  // TypeScript needs this but it's unreachable
  throw new Error('Unreachable: capRoverFetch exhausted retries without throwing');
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
    // Debug logging for connection attempt
    if (verbose) {
      console.log(`  Attempting to connect to CapRover:`);
      console.log(`    URL: ${url}`);
      console.log(`    API Base: ${base}`);
      console.log(`    Password: ${password ? '***SET***' : '***NOT SET***'}`);
    }

    // Login to CapRover API
    let res: Response;
    try {
      res = await capRoverFetch(`${base}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-namespace': 'captain' },
        body: new URLSearchParams({ password })
      }, 3, verbose);
    } catch (fetchError: any) {
      // Capture detailed error information
      const errorDetails = {
        message: fetchError.message || 'Unknown error',
        code: fetchError.code || 'NO_CODE',
        cause: fetchError.cause ? String(fetchError.cause) : 'NO_CAUSE',
        type: fetchError.constructor?.name || 'Unknown',
        errno: fetchError.errno,
        syscall: fetchError.syscall
      };

      console.error(`\n❌ CapRover Connection Failed - Detailed Error:`);
      console.error(`  Message: ${errorDetails.message}`);
      console.error(`  Error Code: ${errorDetails.code}`);
      console.error(`  Error Type: ${errorDetails.type}`);
      if (errorDetails.cause !== 'NO_CAUSE') {
        console.error(`  Cause: ${errorDetails.cause}`);
      }
      if (errorDetails.errno) {
        console.error(`  Errno: ${errorDetails.errno}`);
      }
      if (errorDetails.syscall) {
        console.error(`  Syscall: ${errorDetails.syscall}`);
      }
      console.error(`  Target URL: ${base}/login`);
      console.error(`  Full URL: ${url}\n`);

      if (verbose && fetchError.stack) {
        console.error(`  Stack trace:\n${fetchError.stack}`);
      }

      throw new Error(`Failed to connect to CapRover at ${url}: [${errorDetails.code}] ${errorDetails.message}. Please check that the server is accessible and the URL is correct.`);
    }

    const login = await res.json().catch(() => ({} as any)) as any;
    const token = login?.data?.token;

    if (!token) {
      throw new Error(`Failed to authenticate with CapRover API at ${url}. Status: ${res.status}. Please verify CAPROVER_PASSWORD is correct.`);
    }

    // Check if app already exists
    const defsRes = await capRoverFetch(`${base}/user/apps/appDefinitions/`, {
      headers: { 'x-namespace': 'captain', 'x-captain-auth': token }
    }, 3, verbose);

    const defsJson = defsRes.ok ? await defsRes.json().catch(() => null) : null as any;
    const existingApps = defsJson?.data?.appDefinitions || [];
    const existingApp = existingApps.find((a: any) => (a?.appName || '').toLowerCase() === appName.toLowerCase());

    if (existingApp) {
      // App already exists - check its current deploy token status
      const hasToken = !!(existingApp?.appDeployTokenConfig?.appDeployToken);
      const tokenEnabled = existingApp?.appDeployTokenConfig?.enabled === true;

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
        if (hasToken && tokenEnabled) {
          console.log(`  ✓ App deploy token already enabled`);
          appToken = existingApp.appDeployTokenConfig.appDeployToken;
        } else if (!tokenEnabled) {
          console.log(`  ⚠️  App deploy token not enabled - will attempt to enable it`);
        }
      }

      // Continue to token enabling logic below (don't skip)
    } else {
    // Register app with retry logic for 429 "operation in progress" errors
    const maxRetries = 3;
    let registrationSuccess = false;

    for (let attempt = 0; attempt < maxRetries && !registrationSuccess; attempt++) {
      try {
        res = await capRoverFetch(`${base}/user/apps/appDefinitions/register/`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-namespace': 'captain', 'x-captain-auth': token },
          body: JSON.stringify({ appName })
        }, 3, verbose);

        if (!res.ok) {
          // Try alternative path variant
          res = await capRoverFetch(`${base}/user/apps/appDefinitions/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-namespace': 'captain', 'x-captain-auth': token },
            body: JSON.stringify({ appName })
          }, 3, verbose);
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
          const r = await capRoverFetch(`${base}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-namespace': 'captain', 'x-captain-auth': token },
            body: JSON.stringify({ appName })
          }, 3, verbose);

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

    // Compute API URL for new apps
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
              await capRoverFetch(`${base}/user/apps/appDefinitions/delete/`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-namespace': 'captain', 'x-captain-auth': token },
                body: JSON.stringify({ appName })
              }, 3, verbose);
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

    // Enable app deploy token for both new and existing apps (if not already enabled)
    if (!appToken || existingApp?.appDeployTokenConfig?.enabled !== true) {
      try {
        const defs1 = await capRoverFetch(`${base}/user/apps/appDefinitions/`, {
          headers: { 'x-namespace': 'captain', 'x-captain-auth': token }
        }, 3, verbose);

        const defsJson1 = defs1.ok ? await defs1.json().catch(() => null) : null as any;
        const list = defsJson1?.data?.appDefinitions || [];
        const current = list.find((d: any) => (d?.appName || '').toLowerCase() === appName.toLowerCase());

        if (current) {
          const body: any = {
            appName,
            projectId: current.projectId || '',
            description: current.description || '',
            instanceCount: current.instanceCount ?? 1,
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

          await capRoverFetch(`${base}/user/apps/appDefinitions/update/`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-namespace': 'captain', 'x-captain-auth': token },
            body: JSON.stringify(body)
          }, 3, verbose);

          if (verbose) {
            console.log(`  ✓ Enabled app deploy token`);
          }
        }

        // Fetch updated definitions to get the token
        const defs2 = await capRoverFetch(`${base}/user/apps/appDefinitions/`, {
          headers: { 'x-namespace': 'captain', 'x-captain-auth': token }
        }, 3, verbose);

        const defsJson2 = defs2.ok ? await defs2.json().catch(() => null) : null as any;
        const list2 = defsJson2?.data?.appDefinitions || [];
        const after = list2.find((d: any) => (d?.appName || '').toLowerCase() === appName.toLowerCase());
        appToken = after?.appDeployTokenConfig?.appDeployToken || '';

        if (appToken && verbose) {
          console.log(`  ✓ Retrieved app deploy token`);
        }
      } catch (e: any) {
        if (verbose) {
          console.warn(`  Warning: Could not enable/retrieve app token: ${e?.message || e}`);
        }
      }
    }

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
          console.warn(`  ⚠️  Service account '${existingServiceAccountName}' found but token is missing`);
          console.warn(`  To fix: Re-run with --force to recreate service account and save token:`);
          console.warn(`    provision-wasp-saas --provision-caprover --env ${envSuffix} --force`);
          console.warn(`  Or manually set OP_SERVICE_ACCOUNT_TOKEN in CapRover if the service account still works`);
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

          // Login for verification
          const loginRes = await capRoverFetch(`${base}/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-namespace': 'captain' },
            body: new URLSearchParams({ password: verifyPassword })
          }, 3, verbose);
          const loginJson = await loginRes.json().catch(() => ({} as any)) as any;
          const token = loginJson?.data?.token;

          if (token) {
            // Get app definition
            const defsRes = await capRoverFetch(`${base}/user/apps/appDefinitions/`, {
              headers: { 'x-namespace': 'captain', 'x-captain-auth': token }
            }, 3, verbose);
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
          // Verification failed, but env vars might still be set - this is non-fatal
          if (verbose) {
            const errorDetails = {
              message: verifyError.message || 'Unknown error',
              code: verifyError.code || 'NO_CODE',
              type: verifyError.constructor?.name || 'Unknown'
            };
            console.log(`  ✓ CapRover environment variables set (verification skipped)`);
            console.log(`    Verification error: [${errorDetails.code}] ${errorDetails.message}`);
            console.log(`    This is non-fatal - env vars were likely set successfully`);
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

        // Add token if available (either just created or retrieved from vault)
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

      // CRITICAL: Verify service account token was saved if it exists
      if (serviceAccountToken) {
        const verifyToken = opReadField(vaultName, 'CapRover', 'ServiceAccount', 'token');
        if (!verifyToken || verifyToken !== serviceAccountToken) {
          throw new Error(
            `CRITICAL: Service account token was NOT saved to 1Password vault!\n` +
            `Expected token but got: ${verifyToken ? 'different value' : 'null'}\n` +
            `This will cause future runs to fail. Re-run with --force to recreate the item.`
          );
        }
        if (verbose) {
          console.log(`  ✓ Verified service account token saved to vault`);
        }
      }
    } catch (e: any) {
      // CRITICAL: Make this a fatal error, not a warning
      throw new Error(
        `CRITICAL: Failed to save to 1Password vault: ${e?.message || e}\n` +
        `CapRover app was created but integration will not work without vault storage.\n` +
        `Please fix 1Password access and re-run with --force.`
      );
    }

    if (!appToken && !existingApp) {
      // Only warn if this is a new app - existing apps may not have tokens enabled
      console.warn(`  ⚠️  App token not generated. To enable deployment:`);
      console.warn(`     1. Go to CapRover UI → Apps → ${appName}`);
      console.warn(`     2. Enable "App Deploy Token" in settings`);
      console.warn(`     3. Re-run this command to retrieve and save the token`);
    } else if (!appToken && existingApp) {
      // Existing app without token - provide guidance
      if (!verbose) {
        console.warn(`  ⚠️  App deploy token not found (enable in CapRover UI if needed)`);
      }
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
    // Provide helpful error message based on error type
    const errorMsg = e?.message || String(e);

    if (errorMsg.includes('Failed to connect to CapRover')) {
      throw new Error(`CapRover provisioning failed: ${errorMsg}\n\nTroubleshooting:\n1. Verify the CapRover server is running and accessible\n2. Check your network connection\n3. Confirm CAPROVER_URL is correct: ${url}`);
    } else if (errorMsg.includes('Failed to authenticate')) {
      throw new Error(`CapRover provisioning failed: ${errorMsg}\n\nTroubleshooting:\n1. Verify CAPROVER_PASSWORD is correct\n2. Try logging into CapRover web UI with the same password`);
    } else {
      throw new Error(`CapRover provisioning failed: ${errorMsg}`);
    }
  }
}

/**
 * List all CapRover apps for cleanup
 */
export async function listCapRoverInstances(
  options: { projectName?: string; envSuffix?: 'dev' | 'prod'; filterPattern?: string; verbose?: boolean }
): Promise<Array<{ id: string; name: string; environment?: 'dev' | 'prod' | 'unknown'; metadata?: any; createdAt?: string }>> {
  const { projectName, envSuffix, filterPattern, verbose } = options;

  // Get CapRover credentials using the credential system
  const credentials = getCapRoverCredentials();
  const url = credentials.url;
  const password = credentials.password;

  if (!url) {
    throw new Error(getMissingCredentialsMessage('caprover') + '\nSpecifically missing: CAPROVER_URL');
  }

  if (!password) {
    throw new Error(getMissingCredentialsMessage('caprover') + '\nSpecifically missing: CAPROVER_PASSWORD');
  }

  if (verbose) {
    console.log(`  Debug: CAPROVER_URL is set`);
    console.log(`  Debug: CAPROVER_PASSWORD is set`);
  }

  const base = apiBase(url);

  if (verbose) {
    console.log(`  Debug: Connecting to CapRover at ${base}`);
  }

  try {
    // Login
    const loginResp = await capRoverFetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-namespace': 'captain' },
      body: JSON.stringify({ password })
    }, 3, verbose);

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
    appsResp = await capRoverFetch(`${base}/user/apps/appDefinitions`, {
      headers: { 'x-namespace': 'captain', 'x-captain-auth': token }
    }, 3, verbose);

    if (verbose) {
      console.log(`  Debug: Apps list response status (v2): ${appsResp.status}`);
    }

    if (!appsResp.ok) {
      // Fall back to non-versioned API
      appsResp = await capRoverFetch(`${base}/user/apps/appDefinitions`, {
        headers: { 'x-namespace': 'captain', 'x-captain-auth': token }
      }, 3, verbose);

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
      const res = await capRoverFetch(`${base}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-namespace': 'captain' },
        body: new URLSearchParams({ password })
      }, 3, verbose);

      const login = await res.json().catch(() => ({} as any)) as any;
      const token = login?.data?.token;

      if (!token) {
        throw new Error('Failed to authenticate with CapRover API');
      }

      // Get current app definition
      const defs = await capRoverFetch(`${base}/user/apps/appDefinitions/`, {
        headers: { 'x-namespace': 'captain', 'x-captain-auth': token }
      }, 3, verbose);

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

      const updateRes = await capRoverFetch(`${base}/user/apps/appDefinitions/update/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-namespace': 'captain', 'x-captain-auth': token },
        body: JSON.stringify(body)
      }, 3, verbose);

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

  try {
    // Get CapRover credentials using the credential system
    const credentials = getCapRoverCredentials();
    const url = credentials.url;
    const password = credentials.password;

    if (!url || !password) {
      throw new Error(getMissingCredentialsMessage('caprover'));
    }

    const base = apiBase(url);

    // Login
    const loginResp = await capRoverFetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-namespace': 'captain' },
      body: JSON.stringify({ password })
    }, 3, verbose);

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
    const deleteResp = await capRoverFetch(`${base}/user/apps/appDefinitions/delete/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-namespace': 'captain', 'x-captain-auth': token },
      body: JSON.stringify({ appName: instanceId })
    }, 3, verbose);

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
