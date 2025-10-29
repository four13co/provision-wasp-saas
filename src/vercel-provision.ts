import { execSync } from 'node:child_process';
import { ensureOpAuth, opGetItem, opItemField, opReadRef, opEnsureVault } from './op-util.js';

const VERBOSE = process.env.TZ_VERBOSE === '1' || process.argv.includes('--verbose');
function sh(cmd: string, opts: { capture?: boolean } = {}) {
  if (opts.capture) return execSync(cmd, { stdio: 'pipe' }).toString();
  if (VERBOSE) {
    console.log(`$ ${cmd}`);
    execSync(cmd, { stdio: 'inherit' });
  } else {
    execSync(cmd, { stdio: 'ignore' });
  }
  return '';
}

function getEnv(name: string, req = false) {
  const v = process.env[name];
  if (!v && req) throw new Error(`Missing env: ${name}`);
  return v;
}

function getVercelToken(): string {
  const direct = process.env.VERCEL_TOKEN;
  if (direct) {
    if (/^op:\/\//i.test(direct)) { ensureOpAuth(); const v = opReadRef(direct); if (v) return v; }
    return direct;
  }
  ensureOpAuth();
  const vault = process.env.OP_VAULT_MASTER || 'tz-saas-master';
  const item = opGetItem(vault, 'VERCEL');
  let token = opItemField(item, 'VERCEL_TOKEN') || opItemField(item, 'TOKEN');
  if (!token && item?.fields) {
    const f = item.fields.find((x) => (x.label || '').toLowerCase().includes('token'));
    token = (f?.value as string) || null;
  }
  if (!token) throw new Error('Missing env: VERCEL_TOKEN (and not found in 1Password VERCEL item)');
  return token;
}

function getVercelOrgId(): string | undefined {
  // Prefer env variables
  const orgId = process.env.VERCEL_ORG_ID || process.env.VERCEL_TEAM_ID || undefined;
  if (orgId) return orgId;

  // Fallback to 1Password master vault item VERCEL
  try {
    ensureOpAuth();
    const vault = process.env.OP_VAULT_MASTER || 'tz-saas-master';
    const item = opGetItem(vault, 'VERCEL');
    const vOrgId = opItemField(item, 'ORG_ID') || opItemField(item, 'TEAM_ID') || undefined;
    if (vOrgId) return vOrgId;
  } catch (e) { /* ignore */ }

  return undefined;
}

interface VercelProject {
  id: string;
  name: string;
}

function listProjects(token: string, orgId?: string): VercelProject[] {
  try {
    const url = orgId ? `https://api.vercel.com/v9/projects?teamId=${orgId}` : 'https://api.vercel.com/v9/projects';
    const result = sh(`curl -s -H "Authorization: Bearer ${token}" "${url}"`, { capture: true });
    const data = JSON.parse(result);
    return (data.projects || []).map((p: any) => ({ id: p.id, name: p.name }));
  } catch (e) {
    console.warn('Failed to list Vercel projects:', (e as Error).message);
    return [];
  }
}

function ensureProject(token: string, projectName: string, orgId?: string): VercelProject | null {
  const existing = listProjects(token, orgId).find((p) => p.name === projectName);
  if (existing) return existing;

  // Create new project
  try {
    const body = JSON.stringify({
      name: projectName,
      framework: 'nextjs'
    });

    // teamId must be a query parameter, not in body
    const url = orgId
      ? `https://api.vercel.com/v9/projects?teamId=${orgId}`
      : 'https://api.vercel.com/v9/projects';

    const result = sh(
      `curl -s -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '${body.replace(/'/g, "'\\''")}' "${url}"`,
      { capture: true }
    );

    const data = JSON.parse(result);
    if (data.error) {
      console.warn(`Failed to create Vercel project ${projectName}:`, data.error.message);
      return null;
    }

    return { id: data.id, name: data.name };
  } catch (e) {
    console.warn(`Failed to create Vercel project ${projectName}:`, (e as Error).message);
    return null;
  }
}

function setProjectEnvVar(
  token: string,
  projectId: string,
  key: string,
  value: string,
  target: 'production' | 'preview' | 'development' = 'production',
  orgId?: string
): void {
  try {
    const body = JSON.stringify({
      key,
      value,
      target: [target],
      type: 'encrypted'
    });

    const url = orgId
      ? `https://api.vercel.com/v10/projects/${projectId}/env?teamId=${orgId}`
      : `https://api.vercel.com/v10/projects/${projectId}/env`;

    const result = sh(
      `curl -s -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '${body.replace(/'/g, "'\\''")}' "${url}"`,
      { capture: true }
    );

    const data = JSON.parse(result);
    if (data.error) {
      console.warn(`Failed to set ${key} on project ${projectId}:`, data.error.message);
    } else if (VERBOSE) {
      console.log(`Set ${key}=${value} on project ${projectId} (${target})`);
    }
  } catch (e) {
    console.warn(`Failed to set ${key} on project ${projectId}:`, (e as Error).message);
  }
}

function saveToVault(
  vault: string | undefined | null,
  baseName: string,
  dev: VercelProject | null | undefined,
  prod: VercelProject | null | undefined,
  envSuffix: 'dev' | 'prod',
  orgId?: string
) {
  if (!vault) return;
  try {
    try { sh(`op item get --vault "${vault}" VERCEL`); }
    catch (e) { sh(`op item create --vault "${vault}" --category=LOGIN --title "VERCEL" --url=local`); }

    if (dev) {
      sh(`op item edit --vault "${vault}" VERCEL VERCEL_PROJECT_ID_DEV=${dev.id}`);
      sh(`op item edit --vault "${vault}" VERCEL VERCEL_PROJECT_NAME_DEV=${dev.name}`);
    }
    if (prod) {
      sh(`op item edit --vault "${vault}" VERCEL VERCEL_PROJECT_ID_PROD=${prod.id}`);
      sh(`op item edit --vault "${vault}" VERCEL VERCEL_PROJECT_NAME_PROD=${prod.name}`);
    }

    // Store org ID if provided
    if (orgId) {
      sh(`op item edit --vault "${vault}" VERCEL VERCEL_ORG_ID=${orgId}`);
    }

    // Store APP_URL for current environment only; ensure item exists
    const project = envSuffix === 'prod' ? prod : dev;
    if (project) {
      try { sh(`op item get --vault "${vault}" APP_URL`); }
      catch { sh(`op item create --vault "${vault}" --category=LOGIN --title "APP_URL" --url=local`); }
      sh(`op item edit --vault "${vault}" APP_URL username='https://${project.name}.vercel.app'`);
    }
  } catch (e) {
    console.warn('Could not write Vercel project IDs to 1Password:', (e as Error).message);
  }
}

function main() {
  const token = getVercelToken();
  const baseName = process.env.VERCEL_PROJECT_NAME || process.env.PROJECT_NAME || 'tz-saas-site';
  const envSuffix = process.env.ENV_SUFFIX || 'dev';
  const vault = `${(process.env.PROJECT_NAME || 'tz-saas-site')}-${envSuffix}`;
  const orgId = getVercelOrgId();

  try {
    // Create projects with -frontend suffix for split repo architecture
    const dev = ensureProject(token, `${baseName}-frontend-dev`, orgId);
    if (dev) {
      console.log(`Ensured Vercel project: ${dev.name} (${dev.id})`);
      // Set ENABLE_EXPERIMENTAL_COREPACK for pnpm support
      setProjectEnvVar(token, dev.id, 'ENABLE_EXPERIMENTAL_COREPACK', '1', 'production', orgId);
      setProjectEnvVar(token, dev.id, 'ENABLE_EXPERIMENTAL_COREPACK', '1', 'preview', orgId);
      setProjectEnvVar(token, dev.id, 'ENABLE_EXPERIMENTAL_COREPACK', '1', 'development', orgId);
    }

    const prod = ensureProject(token, `${baseName}-frontend-prod`, orgId);
    if (prod) {
      console.log(`Ensured Vercel project: ${prod.name} (${prod.id})`);
      // Set ENABLE_EXPERIMENTAL_COREPACK for pnpm support
      setProjectEnvVar(token, prod.id, 'ENABLE_EXPERIMENTAL_COREPACK', '1', 'production', orgId);
      setProjectEnvVar(token, prod.id, 'ENABLE_EXPERIMENTAL_COREPACK', '1', 'preview', orgId);
      setProjectEnvVar(token, prod.id, 'ENABLE_EXPERIMENTAL_COREPACK', '1', 'development', orgId);
    }

    if (vault) { ensureOpAuth(); opEnsureVault(vault); }
    const envKey = (envSuffix === 'prod' ? 'prod' : 'dev') as 'dev'|'prod';
    saveToVault(vault, baseName, dev, prod, envKey, orgId);

    // Also persist VERCEL_TOKEN into the project vault for CI-only use
    try { if (vault && token) sh(`op item edit --vault "${vault}" VERCEL VERCEL_TOKEN=${token}`); } catch {}

    if (VERBOSE) {
      console.log(JSON.stringify({ dev: dev || null, prod: prod || null }, null, 2));
    } else {
      console.log(`[vercel] Ensured frontend projects: ${dev?.name || 'dev?'} ${prod?.name ? 'and ' + prod.name : ''}`.trim());
    }
  } catch (e) {
    console.error('Vercel provision failed:', (e as Error).message);
    process.exit(1);
  }
}

main();
