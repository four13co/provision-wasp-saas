/* Master vault bootstrap
   Requires: OP_SERVICE_ACCOUNT_TOKEN, OP_VAULT_MASTER
   Seeds global automation credentials only. Does NOT store app env.
*/
import { execSync } from 'node:child_process';

function sh(cmd: string) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

const MASTER_VAULT = process.env.OP_VAULT_MASTER || 'tz-saas-master';

function op(cmd: string) {
  return `op ${cmd}`;
}

function ensureVault(name: string) {
  try {
    sh(op(`vault get --vault "${name}"`));
  } catch {
    sh(op(`vault create "${name}"`));
  }
}

function ensureOpAuth() {
  try {
    execSync('op whoami', { stdio: 'ignore' });
  } catch {
    console.error('[op] Not authenticated. Run `op signin` (biometric/interactive) or export OP_SERVICE_ACCOUNT_TOKEN.');
  }
}

function main() {
  ensureOpAuth();

  ensureVault(MASTER_VAULT);
  const v = `--vault "${MASTER_VAULT}"`;

  // Ensure NETLIFY item exists
  try { sh(op(`item get ${v} NETLIFY`)); }
  catch { sh(op(`item create ${v} --category=LOGIN --title "NETLIFY" --url=local`)); }
  // Ensure CAPROVER item with fields url + credential exists
  try { sh(op(`item get ${v} CAPROVER`)); }
  catch { sh(op(`item create ${v} --category=LOGIN --title "CAPROVER" --url=local`)); }
  // Optional: CLOUDFLARE item
  try { sh(op(`item get ${v} CLOUDFLARE`)); }
  catch { sh(op(`item create ${v} --category=LOGIN --title "CLOUDFLARE" --url=local`)); }
  // Optional: OP service account references
  try { sh(op(`item get ${v} OP_SERVICE_ACCOUNTS`)); }
  catch { sh(op(`item create ${v} --category=SECURE_NOTE --title "OP_SERVICE_ACCOUNTS"`)); }

  console.log('Master vault bootstrap complete:', MASTER_VAULT);
}

main();
