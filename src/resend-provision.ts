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

function getResendMasterKey(): string {
  const direct = process.env.RESEND_API_KEY || process.env.RESEND_MASTER_KEY;
  if (direct) {
    if (/^op:\/\//i.test(direct)) {
      ensureOpAuth();
      const v = opReadRef(direct);
      if (v) return v;
    }
    return direct;
  }
  ensureOpAuth();
  const vault = process.env.OP_VAULT_MASTER || 'tz-saas-master';
  const item = opGetItem(vault, 'RESEND');
  let key = opItemField(item, 'credential') || opItemField(item, 'API_KEY') || opItemField(item, 'RESEND_API_KEY');
  if (!key && item?.fields) {
    const f = item.fields.find((x) => (x.label || '').toLowerCase().includes('key') || (x.label || '').toLowerCase().includes('credential'));
    key = (f?.value as string) || null;
  }
  if (!key) throw new Error('Missing env: RESEND_API_KEY (and not found in 1Password RESEND item at op://tz-saas-master/RESEND/credential)');
  return key;
}

async function createApiKey(masterKey: string, keyName: string): Promise<{ id: string; token: string } | null> {
  try {
    const response = await fetch('https://api.resend.com/api-keys', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${masterKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: keyName,
        permission: 'sending_access'
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Resend API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as { id: string; token: string };
    return data;
  } catch (e) {
    console.error(`Failed to create Resend API key "${keyName}":`, (e as Error).message);
    return null;
  }
}

function saveToVault(
  vault: string | undefined | null,
  baseName: string,
  devKey: { id: string; token: string } | null | undefined,
  prodKey: { id: string; token: string } | null | undefined,
  envSuffix: 'dev' | 'prod'
) {
  if (!vault) return;
  try {
    // Ensure RESEND item exists in project vault
    try { sh(`op item get --vault "${vault}" RESEND`); }
    catch (e) { sh(`op item create --vault "${vault}" --category=LOGIN --title "RESEND" --url=local`); }

    // Store keys
    if (devKey) {
      sh(`op item edit --vault "${vault}" RESEND RESEND_API_KEY_DEV_ID=${devKey.id}`);
      sh(`op item edit --vault "${vault}" RESEND RESEND_API_KEY_DEV="${devKey.token}"`);
    }
    if (prodKey) {
      sh(`op item edit --vault "${vault}" RESEND RESEND_API_KEY_PROD_ID=${prodKey.id}`);
      sh(`op item edit --vault "${vault}" RESEND RESEND_API_KEY_PROD="${prodKey.token}"`);
    }

    // Store active key for current environment
    const activeKey = envSuffix === 'prod' ? prodKey : devKey;
    if (activeKey) {
      sh(`op item edit --vault "${vault}" RESEND RESEND_API_KEY="${activeKey.token}"`);
      if (VERBOSE) {
        console.log(`✓ Stored RESEND_API_KEY in vault ${vault} for ${envSuffix} environment`);
      }
    }

    // Store EMAIL_FROM for current environment
    const emailFrom = envSuffix === 'prod'
      ? `no-reply@${baseName}.com`
      : `no-reply@dev.${baseName}.com`;
    sh(`op item edit --vault "${vault}" RESEND EMAIL_FROM="${emailFrom}"`);
    if (VERBOSE) {
      console.log(`✓ Stored EMAIL_FROM in vault ${vault}: ${emailFrom}`);
    }
  } catch (e) {
    console.warn('Could not write Resend keys to 1Password:', (e as Error).message);
  }
}

async function main() {
  const masterKey = getResendMasterKey();
  const baseName = process.env.PROJECT_NAME || 'tz-saas-project';
  const envSuffix = process.env.ENV_SUFFIX || 'dev';
  const vault = `${baseName}-${envSuffix}`;

  try {
    console.log('[resend] Creating project-specific API keys...');

    const devKey = await createApiKey(masterKey, `${baseName}-dev`);
    if (devKey) {
      console.log(`✓ Created Resend API key: ${baseName}-dev (${devKey.id})`);
    }

    const prodKey = await createApiKey(masterKey, `${baseName}-prod`);
    if (prodKey) {
      console.log(`✓ Created Resend API key: ${baseName}-prod (${prodKey.id})`);
    }

    if (!devKey && !prodKey) {
      throw new Error('Failed to create any Resend API keys');
    }

    if (vault) {
      ensureOpAuth();
      opEnsureVault(vault);
    }

    const envKey = (envSuffix === 'prod' ? 'prod' : 'dev') as 'dev' | 'prod';
    saveToVault(vault, baseName, devKey, prodKey, envKey);

    if (VERBOSE) {
      console.log(JSON.stringify({
        dev: devKey ? { id: devKey.id, token: '***' } : null,
        prod: prodKey ? { id: prodKey.id, token: '***' } : null
      }, null, 2));
    } else {
      console.log(`[resend] Created API keys: ${devKey ? `${baseName}-dev` : 'dev?'} ${prodKey ? `and ${baseName}-prod` : ''}`.trim());
    }
  } catch (e) {
    console.error('Resend provision failed:', (e as Error).message);
    process.exit(1);
  }
}

main();
