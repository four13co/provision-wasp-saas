/**
 * Emit .env files for Wasp projects from 1Password vault or environment
 * Writes .env.server and .env.client files
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { EnvEmitOptions } from './types.js';

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeEnv(filePath: string, entries: Array<[string, string]>) {
  ensureDir(filePath);
  const lines = entries.map(([k, v]) => `${k}=${escapeValue(v)}`).join('\n') + '\n';
  fs.writeFileSync(filePath, lines, 'utf8');
}

function escapeValue(v: string) {
  // Basic .env escaping: wrap if contains whitespace or special chars, escape newlines
  const needsQuotes = /\s|[#'"\\]/.test(v);
  const clean = v.replace(/\n/g, '\\n');
  return needsQuotes ? JSON.stringify(clean) : clean;
}

function getVaultEnv(vaultName: string): NodeJS.ProcessEnv {
  try {
    // Load all items from the vault
    const result = execSync(
      `op item list --vault "${vaultName}" --format json`,
      { stdio: 'pipe' }
    ).toString();

    const items = JSON.parse(result) as Array<{ id: string; title: string }>;
    const env: NodeJS.ProcessEnv = {};

    for (const item of items) {
      try {
        // Get the item details
        const itemJson = execSync(
          `op item get --vault "${vaultName}" "${item.title}" --format json`,
          { stdio: 'pipe' }
        ).toString();

        const itemData = JSON.parse(itemJson);

        // Extract password field value
        if (itemData.fields) {
          const passwordField = itemData.fields.find((f: any) => f.type === 'CONCEALED' || f.id === 'password');
          if (passwordField?.value) {
            env[item.title] = passwordField.value;
          }

          // Also extract username field for items like URLs
          const usernameField = itemData.fields.find((f: any) => f.id === 'username');
          if (usernameField?.value && !env[item.title]) {
            env[item.title] = usernameField.value;
          }
        }
      } catch (e) {
        // Skip items that can't be read
      }
    }

    return env;
  } catch (e: any) {
    throw new Error(`Failed to load environment from 1Password vault ${vaultName}: ${e?.message || e}`);
  }
}

function pickServerEnv(env: NodeJS.ProcessEnv): Array<[string, string]> {
  // Wasp server-side environment variables
  const keys = [
    'DATABASE_URL',
    'JWT_SECRET',
    // Stripe/Payments
    'STRIPE_API_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_CUSTOMER_PORTAL_URL',
    'PAYMENTS_HOBBY_SUBSCRIPTION_PLAN_ID',
    'PAYMENTS_PRO_SUBSCRIPTION_PLAN_ID',
    // Email
    'SENDGRID_API_KEY',
    'RESEND_API_KEY',
    // Social Auth
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    // Storage
    'AWS_S3_IAM_ACCESS_KEY',
    'AWS_S3_IAM_SECRET_KEY',
    'AWS_S3_FILES_BUCKET',
    // Admin
    'ADMIN_EMAILS',
    // Deployment
    'CAPROVER_URL',
    'CAPROVER_APP_TOKEN',
    'VERCEL_TOKEN',
    'VERCEL_PROJECT_ID',
    'VERCEL_ORG_ID',
    'API_URL'
  ];

  const out: Array<[string, string]> = [];
  for (const k of keys) {
    const v = env[k];
    if (v != null && v !== '') {
      out.push([k, String(v)]);
    }
  }

  return out;
}

function pickClientEnv(env: NodeJS.ProcessEnv): Array<[string, string]> {
  // Wasp client-side variables must start with REACT_APP_
  const out: Array<[string, string]> = [];

  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('REACT_APP_') && v != null && v !== '') {
      out.push([k, String(v)]);
    }
  }

  // Common public keys
  const commonKeys = [
    'REACT_APP_GOOGLE_ANALYTICS_ID',
    'REACT_APP_API_URL',
    'APP_URL'
  ];

  for (const key of commonKeys) {
    if (!out.find(([k]) => k === key) && env[key]) {
      out.push([key, String(env[key])]);
    }
  }

  return out;
}

/**
 * Emit .env files from 1Password vault or environment
 */
export async function emitEnvFiles(options: EnvEmitOptions): Promise<void> {
  const { projectName, envSuffix, vaultName, verbose, dryRun } = options;

  const root = process.cwd();

  if (verbose) {
    console.log(`  Loading environment from vault: ${vaultName}`);
  }

  if (dryRun) {
    console.log(`  [DRY RUN] Would emit .env files from vault: ${vaultName}`);
    return;
  }

  try {
    // Load environment from 1Password vault
    const vaultEnv = getVaultEnv(vaultName);

    // Merge with process.env (process.env takes precedence)
    const mergedEnv = { ...vaultEnv, ...process.env };

    // Write server env file
    const serverVars = pickServerEnv(mergedEnv);
    const serverPath = path.join(root, '.env.server');
    writeEnv(serverPath, serverVars);

    if (verbose) {
      console.log(`  ✓ Wrote .env.server (${serverVars.length} vars)`);
    }

    // Write client env file
    const clientVars = pickClientEnv(mergedEnv);
    const clientPath = path.join(root, '.env.client');
    writeEnv(clientPath, clientVars);

    if (verbose) {
      console.log(`  ✓ Wrote .env.client (${clientVars.length} vars)`);
    }

    // Warn about missing critical vars
    const serverKeys = new Set(serverVars.map(([k]) => k));
    const missingCritical = ['JWT_SECRET', 'DATABASE_URL'].filter(k => !serverKeys.has(k));

    if (missingCritical.length > 0 && verbose) {
      console.warn(`  Warning: Missing critical keys: ${missingCritical.join(', ')}`);
    }

    if (!verbose) {
      console.log(`  ✓ Env files: .env.server (${serverVars.length}), .env.client (${clientVars.length})`);
    }
  } catch (e: any) {
    throw new Error(`Failed to emit env files: ${e?.message || e}`);
  }
}
