/**
 * Emit .env files for Wasp projects from current process.env
 * (expects 1Password GitHub Action to export envs).
 *
 * Usage (CI):
 *   provision-wasp-saas env:emit --target server
 *   provision-wasp-saas env:emit --target all
 *
 * Defaults to server only. Writes:
 *   - .env.server (Wasp backend)
 *   - .env.client (Wasp frontend - REACT_APP_* vars)
 */
import fs from 'node:fs';
import path from 'node:path';

type Target = 'server' | 'client' | 'all';

function parseArgs(): { target: Target } {
  const args = process.argv.slice(2);
  let target: Target = 'server';
  for (const a of args) {
    if (a.startsWith('--target')) {
      const [, val] = a.split('=');
      if (val === 'server' || val === 'client' || val === 'all') target = val;
    }
  }
  return { target };
}

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeEnv(filePath: string, entries: Array<[string, string]>) {
  ensureDir(filePath);
  const lines = entries.map(([k, v]) => `${k}=${escapeValue(v)}`).join('\n') + '\n';
  fs.writeFileSync(filePath, lines, 'utf8');
  console.log(`Wrote ${filePath} (${entries.length} vars)`);
}

function escapeValue(v: string) {
  // Basic .env escaping: wrap if contains whitespace or special chars, escape newlines
  const needsQuotes = /\s|[#'"\\]/.test(v);
  const clean = v.replace(/\n/g, '\\n');
  return needsQuotes ? JSON.stringify(clean) : clean;
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
    'VERCEL_ORG_ID'
  ];
  const out: Array<[string, string]> = [];
  for (const k of keys) {
    const v = env[k];
    if (v != null && v !== '') out.push([k, String(v)]);
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
    'REACT_APP_API_URL'
  ];
  for (const key of commonKeys) {
    if (!out.find(([k]) => k === key) && env[key]) {
      out.push([key, String(env[key])]);
    }
  }
  return out;
}

function requireWarn(list: Array<[string, string]>, required: string[]) {
  const present = new Set(list.map(([k]) => k));
  const missing = required.filter((k) => !present.has(k));
  if (missing.length) {
    console.warn('[env-emit] Missing important keys:', missing.join(', '));
  }
}

function main() {
  // Safety: only allow writing .env files in CI unless explicitly overridden
  const ci = process.env.GITHUB_ACTIONS === '1' || process.env.CI === '1';
  const allowLocal = process.env.WASP_ALLOW_LOCAL_ENV_EMIT === '1';
  if (!ci && !allowLocal) {
    console.warn('[env-emit] Skipping: .env emission is restricted to CI. Set WASP_ALLOW_LOCAL_ENV_EMIT=1 to override locally.');
    process.exit(0);
  }
  const { target } = parseArgs();
  const root = process.cwd();

  if (target === 'server' || target === 'all') {
    const serverVars = pickServerEnv(process.env);
    requireWarn(serverVars, ['JWT_SECRET', 'DATABASE_URL']);
    writeEnv(path.join(root, '.env.server'), serverVars);
  }

  if (target === 'client' || target === 'all') {
    const clientVars = pickClientEnv(process.env);
    writeEnv(path.join(root, '.env.client'), clientVars);
  }
}

main();
