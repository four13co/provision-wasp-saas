/**
 * Emit .env files for Wasp projects with 1Password secret references
 * Writes .env.server and .env.client files containing op:// reference paths
 *
 * These files should be used with `op run --env-file=".env.server" -- <command>`
 * to inject the actual secret values at runtime without exposing them in files.
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

  // Add header explaining how to use 1Password references
  const header = [
    '# This file contains 1Password secret references (op://vault/item/section/field)',
    '# Do NOT commit this file to version control',
    '# Use with: op run --env-file=".env.server" -- <your-command>',
    '# Example: op run --env-file=".env.server" -- wasp start',
    ''
  ].join('\n');

  const lines = entries.map(([k, v]) => `${k}=${escapeValue(v)}`).join('\n') + '\n';
  fs.writeFileSync(filePath, header + lines, 'utf8');
}

function escapeValue(v: string) {
  // Basic .env escaping: wrap if contains whitespace or special chars, escape newlines
  const needsQuotes = /\s|[#'"\\]/.test(v);
  const clean = v.replace(/\n/g, '\\n');
  return needsQuotes ? JSON.stringify(clean) : clean;
}

/**
 * Map of environment variable names to their new sectioned 1Password paths
 * Format: op://vault/Service/Section/field
 */
function getOpReferencePath(vaultName: string, envVar: string): string {
  const pathMap: Record<string, string> = {
    // Auth
    'JWT_SECRET': `op://${vaultName}/Auth/Secrets/jwt_secret`,

    // Neon Database
    'DATABASE_URL': `op://${vaultName}/Neon/Database/database_url`,
    'NEON_PROJECT_ID': `op://${vaultName}/Neon/Database/project_id`,
    'POSTGRES_HOST': `op://${vaultName}/Neon/Connection/postgres_host`,

    // CapRover
    'CAPROVER_APP_NAME': `op://${vaultName}/CapRover/Application/app_name`,
    'CAPROVER_APP_TOKEN': `op://${vaultName}/CapRover/Deployment/app_token`,
    'CAPROVER_URL': `op://${vaultName}/CapRover/Server/url`,
    'API_URL': `op://${vaultName}/CapRover/URLs/api_url`,

    // Vercel (if using Vercel)
    'VERCEL_PROJECT_ID': `op://${vaultName}/Vercel/Project/project_id`,
    'VERCEL_PROJECT_NAME': `op://${vaultName}/Vercel/Project/project_name`,
    'VERCEL_ORG_ID': `op://${vaultName}/Vercel/Organization/org_id`,
    'VERCEL_TOKEN': `op://${vaultName}/Vercel/Credentials/token`,

    // Netlify (if using Netlify)
    'NETLIFY_SITE_ID': `op://${vaultName}/Netlify/Site/site_id`,
    'NETLIFY_SITE_NAME': `op://${vaultName}/Netlify/Site/site_name`,
    'NETLIFY_TOKEN': `op://${vaultName}/Netlify/Credentials/token`,

    // Frontend URL (from Vercel or Netlify)
    'APP_URL': `op://${vaultName}/Vercel/URLs/app_url`, // Try Vercel first, fallback to Netlify

    // Resend
    'RESEND_API_KEY': `op://${vaultName}/Resend/Credentials/api_key`,
    'RESEND_API_KEY_ID': `op://${vaultName}/Resend/Credentials/api_key_id`,
    'EMAIL_FROM': `op://${vaultName}/Resend/Configuration/email_from`,

    // GitHub
    'GITHUB_PAT': `op://${vaultName}/GitHub/Credentials/pat`,
    'GITHUB_USERNAME': `op://${vaultName}/GitHub/Registry/username`,
  };

  return pathMap[envVar] || '';
}

function readOpReference(ref: string): string | null {
  try {
    const value = execSync(`op read "${ref}"`, { stdio: 'pipe' }).toString().trim();
    return value || null;
  } catch (e) {
    return null;
  }
}

function getVaultEnv(vaultName: string): NodeJS.ProcessEnv {
  try {
    const env: NodeJS.ProcessEnv = {};

    // List of all possible environment variables we might want to reference
    const possibleEnvVars = [
      'JWT_SECRET',
      'DATABASE_URL',
      'NEON_PROJECT_ID',
      'POSTGRES_HOST',
      'CAPROVER_APP_NAME',
      'CAPROVER_APP_TOKEN',
      'CAPROVER_URL',
      'API_URL',
      'VERCEL_PROJECT_ID',
      'VERCEL_PROJECT_NAME',
      'VERCEL_ORG_ID',
      'VERCEL_TOKEN',
      'NETLIFY_SITE_ID',
      'NETLIFY_SITE_NAME',
      'NETLIFY_TOKEN',
      'APP_URL',
      'RESEND_API_KEY',
      'RESEND_API_KEY_ID',
      'EMAIL_FROM',
      'GITHUB_PAT',
      'GITHUB_USERNAME',
    ];

    // Write 1Password reference paths instead of actual values
    // Users will use `op run --env-file=".env.server" -- <command>` to inject secrets
    for (const envVar of possibleEnvVars) {
      const opPath = getOpReferencePath(vaultName, envVar);
      if (opPath) {
        // Check if the reference exists (without reading the value)
        // This prevents writing references to non-existent fields
        const value = readOpReference(opPath);
        if (value !== null) {
          // Write the op:// reference instead of the actual value
          env[envVar] = opPath;
        }
      }
    }

    // Special fallback for APP_URL - try Netlify if Vercel not found
    if (!env['APP_URL']) {
      const netlifyAppUrl = `op://${vaultName}/Netlify/URLs/app_url`;
      const exists = readOpReference(netlifyAppUrl);
      if (exists !== null) {
        env['APP_URL'] = netlifyAppUrl;
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
 * Emit .env files with 1Password secret references
 *
 * Creates .env.server and .env.client files containing op:// reference paths
 * instead of actual secret values. Users should run commands with:
 * `op run --env-file=".env.server" -- <command>`
 */
export async function emitEnvFiles(options: EnvEmitOptions): Promise<void> {
  const { projectName, envSuffix, vaultName, verbose, dryRun } = options;

  const root = process.cwd();

  if (verbose) {
    console.log(`  Creating .env files with 1Password references for vault: ${vaultName}`);
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
      console.log(`  ✓ Wrote .env.server (${serverVars.length} 1Password references)`);
    }

    // Write client env file
    const clientVars = pickClientEnv(mergedEnv);
    const clientPath = path.join(root, '.env.client');
    writeEnv(clientPath, clientVars);

    if (verbose) {
      console.log(`  ✓ Wrote .env.client (${clientVars.length} 1Password references)`);
      console.log(`\n  💡 Usage: op run --env-file=".env.server" -- wasp start`);
    }

    // Warn about missing critical vars
    const serverKeys = new Set(serverVars.map(([k]) => k));
    const missingCritical = ['JWT_SECRET', 'DATABASE_URL'].filter(k => !serverKeys.has(k));

    if (missingCritical.length > 0 && verbose) {
      console.warn(`  Warning: Missing critical keys: ${missingCritical.join(', ')}`);
    }

    if (!verbose) {
      console.log(`  ✓ Env files: .env.server (${serverVars.length}), .env.client (${clientVars.length})`);
      console.log(`  💡 Run with: op run --env-file=".env.server" -- wasp start`);
    }
  } catch (e: any) {
    throw new Error(`Failed to emit env files: ${e?.message || e}`);
  }
}
