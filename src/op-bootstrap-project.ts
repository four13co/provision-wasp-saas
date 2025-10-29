/* Project vault bootstrap
   Requires: OP_SERVICE_ACCOUNT_TOKEN, PROJECT_NAME
   Vault: always uses the computed project name ("${PROJECT_NAME}-${ENV_SUFFIX}")
   Seeds app env placeholders and generates JWT secret.
*/
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';

function sh(cmd: string) { console.log(`$ ${cmd}`); execSync(cmd, { stdio: 'inherit' }); }
function op(cmd: string) { return `op ${cmd}`; }

const PROJECT = process.env.PROJECT_NAME || 'my-saas-app';
const ENV = process.env.ENV_SUFFIX || 'dev';
// Per-environment project vault always matches the computed project name
const VAULT = `${PROJECT}-${ENV}`;

function ensureVault(name: string) {
  try { sh(op(`vault get --vault "${name}"`)); }
  catch { sh(op(`vault create "${name}"`)); }
}

function setSecret(title: string, value?: string) {
  try {
    sh(op(`item get --vault "${VAULT}" "${title}"`));
  } catch {
    if (value) {
      sh(op(`item create --vault "${VAULT}" --category=LOGIN --title "${title}" --url=local --generate-password=false password='${value.replace(/'/g, "'\''")}'`));
    } else {
      sh(op(`item create --vault "${VAULT}" --category=LOGIN --title "${title}" --url=local`));
    }
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
  ensureVault(VAULT);

  const jwt = crypto.randomBytes(32).toString('hex');
  setSecret('JWT_SECRET', jwt);
  setSecret('DATABASE_URL');
  setSecret('RESEND_API_KEY');
  setSecret('POSTHOG_API_KEY');
  setSecret('AWS_S3_IAM_ACCESS_KEY');
  setSecret('AWS_S3_IAM_SECRET_KEY');
  setSecret('AWS_S3_REGION');
  setSecret('AWS_S3_BUCKET_NAME');
  setSecret('S3_ENDPOINT');
  setSecret('REDIS_URL');
  setSecret('QDRANT_HOST');
  setSecret('QDRANT_PORT');
  setSecret('QDRANT_API_KEY');
  setSecret('OPENAI_API_KEY');
  setSecret('NETLIFY_SITE_ID');
  setSecret('CAPROVER_APP_NAME');
  setSecret('API_URL');
  setSecret('APP_URL');

  console.log('Project vault bootstrap complete:', VAULT);
}

main();
