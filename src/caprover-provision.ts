import { execSync } from 'node:child_process';
import { ensureOpAuth, opGetItem, opItemField, opEnsureVault } from './op-util.js';

const VERBOSE = process.env.TZ_VERBOSE === '1' || process.argv.includes('--verbose');
function sh(cmd: string) {
  if (VERBOSE) console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: VERBOSE ? 'inherit' : 'ignore' });
}

function apiBase(u: string) {
  const trimmed = u.replace(/\/$/, '');
  return trimmed.includes('/api/') ? trimmed : trimmed + '/api/v2';
}

async function main() {
  let url = process.env.CAPROVER_URL || process.env.CAP_URL;
  let password = process.env.CAPROVER_PASSWORD || process.env.CAP_PASSWD || process.env.CAPROVER_API_TOKEN || process.env.CAPROVER_TOKEN || process.env.CAP_TOKEN;
  const envSuffix = (process.env.ENV_SUFFIX || 'dev');
  let app = process.env.APP_NAME_BACKEND || process.env.CAPROVER_APP_NAME || (process.env.PROJECT_NAME ? `${process.env.PROJECT_NAME}-api-${envSuffix}` : undefined);
  // no server-level SSL enable; only per-app base domain SSL
  const project = (process.env.PROJECT_NAME || 'tz-saas').replace(/[^a-zA-Z0-9_\-]/g, '-');
  const env = envSuffix.replace(/[^a-zA-Z0-9_\-]/g, '-');
  const vault = `${project}-${env}`.toLowerCase();
  const debug = process.env.CAPROVER_DEBUG === '1';

  if (!url || !password) {
    ensureOpAuth();
    const vault = process.env.OP_VAULT_MASTER || 'tz-saas-master';
    const item = opGetItem(vault, 'CAPROVER');
    url = url || opItemField(item, 'url') || undefined;
    password = password || opItemField(item, 'credential') || undefined;
  }
  if (!url || !password || !app) {
    console.log('[caprover:provision] Missing CAPROVER_URL/password or app name');
    process.exit(0);
  }
  try {
    // Direct API based on official collection
    const base = apiBase(url);
    // Login
    let res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-namespace': 'captain' },
      body: new URLSearchParams({ password })
    });
    const login = await res.json().catch((e) => ({} as any)) as any;
    const token = login?.data?.token;
    if (!token) {
      console.warn('[caprover:provision] Login failed; falling back to CLI');
      try {
        sh(`npx --yes caprover@latest apps register -u ${url} -p ${password} -n ${app}`);
        console.log(`[caprover:provision] Ensured app ${app}`);
        return;
      } catch (e) {
        console.error('CapRover provision failed:', (e as Error).message);
        process.exit(1);
      }
    }
    // Register app
    res = await fetch(`${base}/user/apps/appDefinitions/register/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-namespace': 'captain', 'x-captain-auth': token },
      body: JSON.stringify({ appName: app })
    });
    if (!res.ok) {
      // Try alternative path variant
      await fetch(`${base}/user/apps/appDefinitions/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-namespace': 'captain', 'x-captain-auth': token },
        body: JSON.stringify({ appName: app })
      }).catch(() => undefined);
    }
    // Enable HTTPS for the app's base domain (preferred endpoint)
    try {
      const candidates = [
        // Preferred by request
        '/user/apps/appDefinitions/enablebasedomainssl',
        '/user/appDefinitions/enablessl',
        '/user/appDefinitions/enablehttps',
        '/user/appDefinitions/enableHttps',
        '/user/apps/appDefinitions/enablessl',
        '/user/apps/appDefinitions/enablehttps',
        '/user/apps/appDefinitions/enableHttps'
      ];
      let success = false;
      let lastErr: { status?: number; body?: string } = {};
      for (const p of candidates) {
        for (const suffix of ['/', '']) {
          const path = `${p}${suffix}`;
          const r = await fetch(`${base}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-namespace': 'captain', 'x-captain-auth': token },
            body: JSON.stringify({ appName: app })
          });
          const txt = await r.text().catch((e) => '');
          if (r.ok) {
            try {
              const json = JSON.parse(txt);
              const st = json?.status || json?.data?.status;
              if (st === 100 || json?.status === 'OK') { success = true; break; }
            } catch (e) {
              // Non-JSON but 200 OK; consider success
              success = true; break;
            }
          }
          lastErr = { status: r.status, body: txt };
        }
        if (success) break;
      }
      if (success) console.log(`[caprover:provision] HTTPS enabled (requested) for ${app}`);
      else console.warn(`[caprover:provision] Could not enable HTTPS. Last response: ${lastErr.status} ${lastErr.body}`);
    } catch (e) {
      console.warn('[caprover:provision] Could not enable HTTPS (continuing)');
    }
    // Enable app deploy token via update endpoint, then read it from app definitions
    let appToken = '';
    try {
      const defs1 = await fetch(`${base}/user/apps/appDefinitions/`, { headers: { 'x-namespace': 'captain', 'x-captain-auth': token } });
      const defsJson1 = (defs1.ok ? await defs1.json().catch(() => null) : null) as any;
      const list = defsJson1?.data?.appDefinitions || [];
      const current = list.find((d: any) => (d?.appName || '').toLowerCase() === String(app).toLowerCase());
      if (current) {
        const body: any = {
          appName: app,
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
        const upd = await fetch(`${base}/user/apps/appDefinitions/update/`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-namespace': 'captain', 'x-captain-auth': token }, body: JSON.stringify(body) });
        const updTxt = await upd.text().catch(() => '');
        if (debug) console.log('[caprover:provision] update(appDeployTokenConfig) ->', upd.status, updTxt.slice(0, 200));
      }
      const defs2 = await fetch(`${base}/user/apps/appDefinitions/`, { headers: { 'x-namespace': 'captain', 'x-captain-auth': token } });
      const defsJson2 = (defs2.ok ? await defs2.json().catch(() => null) : null) as any;
      const list2 = defsJson2?.data?.appDefinitions || [];
      const after = list2.find((d: any) => (d?.appName || '').toLowerCase() === String(app).toLowerCase());
      appToken = after?.appDeployTokenConfig?.appDeployToken || '';
    } catch (e) {
      if (debug) console.warn('[caprover:provision] token via update/definitions failed:', (e as Error).message);
    }

    // Persist identifiers to the per-environment project vault
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
      put('CAPROVER_URL', 'username', url);
      put('CAPROVER_APP_NAME', 'username', app);
      if (appToken) put('CAPROVER_APP_TOKEN', 'password', appToken);
      // Compute and store API_URL for frontend consumption: https://<app>.<rootDomain>
      try {
        const u = new URL(url);
        const host = u.hostname.replace(/^captain\./, '');
        const apiUrl = `https://${app}.${host}`;
        put('API_URL', 'username', apiUrl);
      } catch {}
    } catch (e) {
      console.warn('[caprover:provision] Failed to write to 1Password:', (e as Error).message);
    }

    if (!appToken) {
      console.warn('[caprover:provision] App token not returned by any known endpoint. You can create it in the CapRover UI (App → App Token) and add it to the project vault as CAPROVER_APP_TOKEN.');
    }
    console.log(`[caprover:provision] Ensured app ${app}${appToken ? ' (captured app token)' : ''}`);
  } catch (e) {
    console.error('CapRover provision failed:', (e as Error).message);
    process.exit(1);
  }
}

main();
