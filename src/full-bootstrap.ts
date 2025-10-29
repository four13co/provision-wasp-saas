/* Full bootstrap: vaults, TWO repos (frontend + API), 1P service account, infra, CI
   Order of operations (designed to set secrets BEFORE first CI run):
   1. Prepares TWO local git repos (frontend + API) but doesn't push yet
   2. Creates TWO GitHub repos (without pushing - avoids premature CI trigger)
   3. Creates <project>-dev and <project>-prod vaults
   4. Creates JWT secrets in each vault for authentication
   5. Creates 1Password service account, grants read to both vaults, sets GH secrets for BOTH repos
   6. Provisions Neon/CapRover/Vercel/Resend for dev and prod (writes only to 1Password)
   7. Pushes code to BOTH GitHub repos (NOW CI can run successfully with all secrets in place)
*/
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { ensureOpAuth, opEnsureVault, opGetItem, opItemField } from './op-util.js';

function sh(cmd: string, opts: { cwd?: string; env?: Record<string,string>; quiet?: boolean } = {}) {
  if (!opts.quiet) console.log(`$ ${cmd}${opts.cwd ? ` (cwd=${opts.cwd})` : ''}`);
  execSync(cmd, { stdio: opts.quiet ? 'ignore' : 'inherit', cwd: opts.cwd, env: { ...process.env, ...(opts.env||{}) } });
}

function getMasterField(item: string, field: string): string | null {
  try {
    ensureOpAuth();
    const vault = process.env.OP_VAULT_MASTER || 'tz-saas-master';
    const it = opGetItem(vault, item);
    return opItemField(it, field);
  } catch {
    return null;
  }
}

function ensureVaults(project: string) {
  ensureOpAuth();
  opEnsureVault(`${project}-dev`);
  opEnsureVault(`${project}-prod`);
}

function ensureJwtSecrets(project: string) {
  ensureOpAuth();
  const envs = ['dev', 'prod'];

  for (const env of envs) {
    const vault = `${project}-${env}`;

    // Check if JWT secret already exists
    try {
      const existing = opGetItem(vault, 'JWT');
      if (existing) {
        console.log(`[bootstrap] JWT secret already exists in ${vault}, skipping`);
        continue;
      }
    } catch {
      // Item doesn't exist, create it
    }

    console.log(`[bootstrap] Creating JWT secret in ${vault}...`);
    // Generate a secure random JWT secret
    const jwtSecret = execSync('openssl rand -base64 32', { encoding: 'utf-8' }).trim();

    // Create the JWT item with JWT_SECRET field
    sh(`op item create --category=password --title="JWT" --vault=${vault} JWT_SECRET="password[${jwtSecret}]" --tags=jwt,auth`, { quiet: true });
  }
}

function openBrowser(url: string) {
  const platform = process.platform;
  let cmd: string;

  if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else if (platform === 'linux') {
    cmd = `xdg-open "${url}"`;
  } else if (platform === 'win32') {
    cmd = `start "${url}"`;
  } else {
    return; // Unknown platform, skip
  }

  try {
    sh(cmd, { quiet: true });
  } catch {
    // Silently fail if browser can't be opened (e.g., headless environment)
  }
}

function findTemplateRoot(cliRoot: string, template: 'frontend' | 'api'): string {
  const candidates = [
    process.env[`APP_ROOT_${template.toUpperCase()}`] && path.resolve(process.env[`APP_ROOT_${template.toUpperCase()}`]!),
    path.resolve(process.cwd(), `templates/${template}`),
    path.resolve(cliRoot, `templates/${template}`),
  ].filter(Boolean) as string[];

  const found = candidates.find((p) => fs.existsSync(p) && fs.existsSync(path.join(p, 'package.json')));
  if (!found) {
    console.error(`[bootstrap] Could not locate templates/${template}. Ensure templates exist in monorepo.`);
    process.exit(1);
  }
  return found;
}

function prepareRepo(appRoot: string, repoName: string) {
  console.log(`[bootstrap] Preparing ${repoName} git repo...`);
  sh('git init', { cwd: appRoot });
  sh('git checkout -B Development', { cwd: appRoot });
  sh('git add .', { cwd: appRoot });
  try { sh("git commit -m 'chore: bootstrap'", { cwd: appRoot }); }
  catch { /* no changes to commit; continue */ }
}

function createGitHubRepo(owner: string, repoName: string) {
  console.log(`[bootstrap] Creating ${repoName} GitHub repo...`);
  try {
    sh(`gh repo create ${owner}/${repoName} --private`, { quiet: true });
  } catch (e) {
    console.warn(`[bootstrap] Repo may already exist: ${owner}/${repoName}. Continuing...`);
  }
}

function setupRemote(appRoot: string, owner: string, repoName: string) {
  const target = `https://github.com/${owner}/${repoName}.git`;
  try {
    const current = execSync('git remote get-url origin', { cwd: appRoot, stdio: 'pipe' }).toString().trim();
    if (current !== target) {
      sh(`git remote set-url origin ${target}`, { cwd: appRoot });
    }
  } catch {
    sh(`git remote add origin ${target}`, { cwd: appRoot });
  }
  // Create Production branch locally (will push later)
  try { sh('git branch -f Production', { cwd: appRoot }); } catch {}
}

function pushRepo(appRoot: string, repoName: string, owner: string) {
  console.log(`[bootstrap] Pushing ${repoName} to GitHub...`);
  // Push Development branch (this will trigger CI with all secrets properly configured)
  try { sh('git push origin Development --set-upstream', { cwd: appRoot }); }
  catch { sh('git push origin Development', { cwd: appRoot }); }
  // Push Production branch
  try { sh('git push origin Production', { cwd: appRoot }); } catch {}
  // Set default branch to Development
  try { sh(`gh api repos/${owner}/${repoName} -X PATCH -f default_branch=Development`, { quiet: true }); } catch {}
}

async function main() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const project = process.env.PROJECT_NAME || 'tz-saas-app';
  const owner = getMasterField('GITHUB', 'OWNER') || getMasterField('GITHUB', 'ORG') || '';
  if (!owner) {
    console.error('[bootstrap] Missing GITHUB OWNER in master vault (GITHUB/OWNER).');
    process.exit(1);
  }
  // Require gh CLI auth; do not fall back to API tokens
  try { sh('gh --version', { quiet: true }); } catch {
    console.error('[bootstrap] GitHub CLI (gh) is required and must be authenticated (gh auth login).');
    process.exit(1);
  }

  const cliRoot = path.resolve(__dirname, '../../..');
  const frontendRepoName = `${project}-frontend`;
  const apiRepoName = `${project}-api`;

  // 1) Find template roots for both frontend and API
  const frontendRoot = findTemplateRoot(cliRoot, 'frontend');
  const apiRoot = findTemplateRoot(cliRoot, 'api');

  // 2) Prepare both git repos locally (but don't push yet)
  prepareRepo(frontendRoot, frontendRepoName);
  prepareRepo(apiRoot, apiRepoName);

  // 3) Create both GitHub repos (without pushing - avoids premature CI trigger)
  createGitHubRepo(owner, frontendRepoName);
  createGitHubRepo(owner, apiRepoName);

  // 4) Set up remotes for both repos
  setupRemote(frontendRoot, owner, frontendRepoName);
  setupRemote(apiRoot, owner, apiRepoName);

  // 5) Create per-environment 1Password vaults
  console.log('[bootstrap] Ensuring per-environment vaults...');
  ensureVaults(project);

  // 6) Create JWT secrets in each vault
  console.log('[bootstrap] Ensuring JWT secrets...');
  ensureJwtSecrets(project);

  // 7) Create 1Password Service Account, grant read-only to both vaults, set GH secrets for BOTH repos
  console.log('[bootstrap] Creating 1Password Service Account and setting GH secrets for BOTH repos...');
  const script = path.resolve(cliRoot, 'scripts/op-service-account.sh');
  if (!fs.existsSync(script)) {
    console.error('[bootstrap] scripts/op-service-account.sh not found.');
  } else {
    // Ensure executable and invoke with bash to avoid permission issues on some systems
    try { sh(`chmod +x ${script}`); } catch {}
    // Set secrets for frontend repo
    sh(`bash ${script} ${owner}/${frontendRepoName} ${project}-dev ${project}-prod`);
    // Set secrets for API repo
    sh(`bash ${script} ${owner}/${apiRepoName} ${project}-dev ${project}-prod`);
  }

  // 8) Provision infra (dev then prod) writing only to 1Password
  console.log('[bootstrap] Provisioning DEV...');
  sh('pnpm --filter @tz/deploy neon:provision', { env: { PROJECT_NAME: project, ENV_SUFFIX: 'dev' } });
  sh('pnpm --filter @tz/deploy caprover:provision', { env: { PROJECT_NAME: project, ENV_SUFFIX: 'dev' } });
  sh('pnpm --filter @tz/deploy vercel:provision', { env: { PROJECT_NAME: project, ENV_SUFFIX: 'dev' } });
  sh('pnpm --filter @tz/deploy resend:provision', { env: { PROJECT_NAME: project, ENV_SUFFIX: 'dev' } });

  console.log('[bootstrap] Provisioning PROD...');
  sh('pnpm --filter @tz/deploy neon:provision', { env: { PROJECT_NAME: project, ENV_SUFFIX: 'prod' } });
  sh('pnpm --filter @tz/deploy caprover:provision', { env: { PROJECT_NAME: project, ENV_SUFFIX: 'prod' } });
  sh('pnpm --filter @tz/deploy vercel:provision', { env: { PROJECT_NAME: project, ENV_SUFFIX: 'prod' } });
  sh('pnpm --filter @tz/deploy resend:provision', { env: { PROJECT_NAME: project, ENV_SUFFIX: 'prod' } });

  // 9) Push both repos and trigger CI after infra + secrets are ready
  pushRepo(frontendRoot, frontendRepoName, owner);
  pushRepo(apiRoot, apiRepoName, owner);

  console.log('[bootstrap] Done. CI workflows will deploy on pushes to Development/Production.');
  console.log('');
  console.log('[bootstrap] ⚠️  IMPORTANT: GitHub Actions requires one-time approval for new private repos');
  console.log('[bootstrap] Opening GitHub Actions pages in your browser...');
  console.log(`[bootstrap] → https://github.com/${owner}/${frontendRepoName}/actions`);
  console.log(`[bootstrap] → https://github.com/${owner}/${apiRepoName}/actions`);
  console.log('[bootstrap] Click "I understand my workflows, go ahead and enable them" on BOTH repos');
  console.log('');

  // Open both Actions pages
  openBrowser(`https://github.com/${owner}/${frontendRepoName}/actions`);
  setTimeout(() => openBrowser(`https://github.com/${owner}/${apiRepoName}/actions`), 1000);
}

main().catch((e) => { console.error(e); process.exit(1); });
