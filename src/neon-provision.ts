/*
  Neon provisioning (hosted Postgres only)
  - Creates a Neon project and captures a DATABASE_URL
  - Optionally writes secrets to a per-project 1Password vault

  Env:
  - NEON_API_KEY: Neon API key (PAT). Supports op:// reference.
  - NEON_ORG_ID: Optional organization id/slug (if needed by your account)
  - NEON_REGION: Neon region id (e.g., 'aws-us-east-1'). Defaults to 'aws-us-east-1'.
  - PROJECT_NAME and ENV_SUFFIX: Used to derive project name, e.g., myapp-dev
  - Vault: always uses the computed project name ("${PROJECT_NAME}-${ENV_SUFFIX}") for 1Password writes
*/
import { execSync } from 'node:child_process';
import { ensureOpAuth, opEnsureVault, opGetItem, opItemField, opReadRef } from './op-util.js';
import { createApiClient, ContentType } from '@neondatabase/api-client';

const VERBOSE = process.env.TZ_VERBOSE === '1' || process.argv.includes('--verbose');
function sh(cmd: string, opts: { capture?: boolean; env?: Record<string, string> } = {}) {
  if (opts.capture) return execSync(`${cmd} 2>&1`, { stdio: 'pipe', env: { ...process.env, ...(opts.env || {}) } }).toString();
  if (VERBOSE) console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: VERBOSE ? 'inherit' : 'ignore', env: { ...process.env, ...(opts.env || {}) } });
  return '';
}

function getEnv(name: string) { return process.env[name]; }

async function neonApiRequest(api: ReturnType<typeof createApiClient>, path: string, method: 'GET'|'POST', body?: unknown) {
  const resp = await api.request({
    path,
    method,
    body,
    type: body ? ContentType.Json : undefined,
  });
  return resp.data as any;
}

function deriveName() {
  const project = (getEnv('PROJECT_NAME') || 'tz-saas').replace(/[^a-zA-Z0-9_\-]/g, '-');
  const env = (getEnv('ENV_SUFFIX') || 'dev').replace(/[^a-zA-Z0-9_\-]/g, '-');
  return `${project}-${env}`.toLowerCase();
}

function pickConnectionString(obj: any): string | '' {
  if (!obj || typeof obj !== 'object') return '';
  // Common response shapes
  const tryList = [
    obj?.connection_uri,
    obj?.connectionString,
    obj?.database_url,
    obj?.databaseUrl,
  ];
  for (const v of tryList) if (typeof v === 'string' && v.includes('postgres')) return v;
  // Look into arrays like connection_uris
  const arrays = [obj?.connection_uris, obj?.connectionUris, obj?.uris, obj?.endpoints, obj?.project?.connection_uris];
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

async function main() {
  // Resolve Neon API key and optional org id
  let apiKey = getEnv('NEON_API_KEY');
  let orgId = getEnv('NEON_ORG_ID');
  if (apiKey && /^op:\/\//i.test(apiKey)) { try { ensureOpAuth(); apiKey = opReadRef(apiKey) || apiKey; } catch {}
  }
  if (orgId && /^op:\/\//i.test(orgId)) { try { ensureOpAuth(); orgId = opReadRef(orgId) || orgId; } catch {} }
  if (!apiKey) {
    try {
      ensureOpAuth();
      const vault = process.env.OP_VAULT_MASTER || 'tz-saas-master';
      const item = opGetItem(vault, 'Neon') || opGetItem(vault, 'NEON') || opGetItem(vault, 'neon');
      apiKey = apiKey || opItemField(item, 'API_KEY') || opItemField(item, 'TOKEN') || undefined as any;
      orgId = orgId || opItemField(item, 'ORG_ID') || opItemField(item, 'ORG') || orgId || undefined as any;
    } catch {}
  }
  if (!apiKey) {
    console.log('[neon] Skipping: NEON_API_KEY not set');
    return;
  }

  const region = getEnv('NEON_REGION') || 'aws-us-east-1';
  const name = deriveName();

  // Create project (with brief retry for transient failures) via official client
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
  try { await attemptCreate(); }
  catch (e: any) {
    const msg = (e && e.response && e.response.data) ? JSON.stringify(e.response.data) : (e?.message || String(e));
    console.warn('[neon] Project create failed:', msg);
    await new Promise((r) => setTimeout(r, 1500));
    try { await attemptCreate(); } catch (e2: any) {
      const msg2 = (e2 && e2.response && e2.response.data) ? JSON.stringify(e2.response.data) : (e2?.message || String(e2));
      console.warn('[neon] Retry failed:', msg2);
      // Fallback: try to find an existing project by name
      try {
        const list: any = await neonApiRequest(api, '/projects', 'GET');
        const arr = (list?.projects || list?.data || list) as any[];
        const found = Array.isArray(arr) ? arr.find((p) => (p?.name || '').toLowerCase() === name.toLowerCase()) : null;
        if (found?.id) projectId = found.id;
      } catch { /* ignore */ }
    }
  }

  // If we didn’t get a URL, try to fetch connection URIs explicitly
  if (projectId && !databaseUrl) {
    try {
      const details = await neonApiRequest(api, `/projects/${projectId}`, 'GET');
      databaseUrl = pickConnectionString(details) || '';
      if (!databaseUrl) {
        const uris = await neonApiRequest(api, `/projects/${projectId}/connection_uris`, 'GET');
        databaseUrl = pickConnectionString(uris) || '';
      }
    } catch (e: any) {
      console.warn('[neon] Failed to fetch connection URIs:', e?.message || e);
    }
  }

  if (!projectId) {
    console.error('[neon] Could not determine project id (check API key and network access)');
  }
  if (!databaseUrl) {
    console.error('[neon] Could not determine DATABASE_URL (project may still be initializing).');
  }

  // Write to 1Password project vault (optional)
  const vault = name; // Always match the computed project name
  if (vault && (projectId || databaseUrl)) {
    try {
      ensureOpAuth();
      opEnsureVault(vault);
      const put = (title: string, field: 'username'|'password', value: string) => {
        if (!value) return;
        try { sh(`op item get --vault "${vault}" "${title}"`); }
        catch { sh(`op item create --vault "${vault}" --category=LOGIN --title "${title}" --url=local`); }
        const esc = value.replace(/'/g, "'\\''");
        sh(`op item edit --vault "${vault}" "${title}" ${field}='${esc}'`);
      };
      if (projectId) put('NEON_PROJECT_ID', 'username', projectId);
      if (databaseUrl) {
        put('DATABASE_URL', 'password', databaseUrl);
        try {
          const u = new URL(databaseUrl);
          put('POSTGRES_HOST', 'username', u.hostname);
        } catch {}
      }
      console.log('[neon] Wrote project details to vault', vault);
    } catch (e: any) {
      console.warn('[neon] Failed to write to 1Password:', e?.message || e);
    }
  }

  if (VERBOSE) {
    console.log(JSON.stringify({ projectId, databaseUrl }, null, 2));
  } else {
    if (projectId && databaseUrl) console.log(`[neon] Ensured project ${name}`);
    else console.log('[neon] Provision incomplete (no projectId or databaseUrl).');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
