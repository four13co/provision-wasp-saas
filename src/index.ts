#!/usr/bin/env node
/**
 * provision-wasp-saas
 *
 * Infrastructure provisioning for Wasp/OpenSaaS projects.
 *
 * Usage:
 *   cd my-wasp-app
 *   npx provision-wasp-saas --provision
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { provision } from './provision.js';
import { ProviderName, cleanupRegistry } from './providers.js';
import { cleanup } from './cleanup.js';
import { checkConfig } from './check-config.js';
import { initCommand } from './init-command.js';
import { auditCommand } from './audit-command.js';
import { updateWorkflows } from './update-workflows.js';

interface CliArgs {
  // Tool commands
  init: boolean;
  checkConfig: boolean;
  audit: boolean;
  updateWorkflows: boolean;

  // Full provisioning
  provision: boolean;

  // Individual components
  provisionOnePassword: boolean;
  provisionNeon: boolean;
  provisionCapRover: boolean;
  provisionVercel: boolean;
  provisionNetlify: boolean;
  provisionResend: boolean;
  provisionGitHub: boolean;
  provisionEnv: boolean;

  // Cleanup operations
  cleanup: boolean;
  cleanupOnePassword: boolean;
  cleanupNeon: boolean;
  cleanupCapRover: boolean;
  cleanupVercel: boolean;
  cleanupNetlify: boolean;
  cleanupResend: boolean;
  cleanupGitHub: boolean;
  interactive: boolean;

  // Cleanup filters
  project?: string;
  filter?: string;
  ids?: string;

  // Environment selection
  env: 'dev' | 'prod' | 'all';

  // Existing flags
  verbose: boolean;
  help: boolean;
  dryRun: boolean;
  force: boolean;
  showValues: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);

  // Helper to extract flag value
  const getFlagValue = (flag: string): string | undefined => {
    const arg = args.find(a => a.startsWith(`--${flag}`));
    if (arg) {
      // Check if value is provided with = syntax
      const eqValue = arg.split('=')[1];
      if (eqValue !== undefined) {
        return eqValue;
      }

      // Check next argument, but don't consume other flags
      const nextIndex = args.indexOf(arg) + 1;
      const nextArg = args[nextIndex];
      if (nextArg && !nextArg.startsWith('-')) {
        return nextArg;
      }
    }
    return undefined;
  };

  // Parse --env flag
  let env: 'dev' | 'prod' | 'all' = 'all';
  const envValue = getFlagValue('env');
  if (envValue && ['dev', 'prod', 'all'].includes(envValue)) {
    env = envValue as 'dev' | 'prod' | 'all';
  }

  return {
    init: args.includes('init') || args.includes('--init'),
    checkConfig: args.includes('--check-config'),
    audit: args.includes('--audit'),
    updateWorkflows: args.includes('--update-workflows'),
    provision: args.includes('--provision'),
    provisionOnePassword: args.includes('--provision-onepassword') || args.includes('--provision-1password'),
    provisionNeon: args.includes('--provision-neon'),
    provisionCapRover: args.includes('--provision-caprover'),
    provisionVercel: args.includes('--provision-vercel'),
    provisionNetlify: args.includes('--provision-netlify'),
    provisionResend: args.includes('--provision-resend'),
    provisionGitHub: args.includes('--provision-github'),
    provisionEnv: args.includes('--provision-env'),
    cleanup: args.includes('--cleanup'),
    cleanupOnePassword: args.includes('--cleanup-onepassword') || args.includes('--cleanup-1password'),
    cleanupNeon: args.includes('--cleanup-neon'),
    cleanupCapRover: args.includes('--cleanup-caprover'),
    cleanupVercel: args.includes('--cleanup-vercel'),
    cleanupNetlify: args.includes('--cleanup-netlify'),
    cleanupResend: args.includes('--cleanup-resend'),
    cleanupGitHub: args.includes('--cleanup-github'),
    interactive: args.includes('--interactive') || args.includes('-i'),
    project: getFlagValue('project'),
    filter: getFlagValue('filter'),
    ids: getFlagValue('ids'),
    env,
    verbose: args.includes('--verbose') || args.includes('-v'),
    help: args.includes('--help') || args.includes('-h'),
    dryRun: args.includes('--dry-run'),
    force: args.includes('--force'),
    showValues: args.includes('--show-values')
  };
}

function showHelp() {
  console.log(`
provision-wasp-saas

Infrastructure provisioning for Wasp/OpenSaaS projects.

USAGE:
  # First time setup - configure credentials
  npx provision-wasp-saas init

  # Then provision infrastructure
  cd my-wasp-app
  npx provision-wasp-saas [options]

SETUP COMMANDS:
  init                           Set up infrastructure credentials in 1Password vault

UPDATE COMMANDS:
  --update-workflows             Update workflow files to latest version (parallel deployments)
                                 Backs up existing files to .github/workflows.backup/

AUDIT COMMANDS:
  --audit --project <name>       Audit 1Password vaults for a project (read-only)
                                 Shows all items, sections, and fields
  --show-values                  Show actual secret values (use with caution!)

PROVISIONING OPTIONS:
  --provision                    Run full infrastructure provisioning (all components)

  --provision-onepassword        Provision only 1Password vaults
  --provision-neon               Provision only Neon database
  --provision-caprover           Provision only CapRover backend hosting
  --provision-vercel             Provision only Vercel frontend hosting
  --provision-netlify            Provision only Netlify frontend hosting
  --provision-resend             Provision only Resend email service
  --provision-github             Setup GitHub repository with CI/CD
  --provision-env                Generate .env files from 1Password

CLEANUP OPTIONS:
  --cleanup                      Cleanup all provisioned infrastructure (list-only by default)
  --cleanup-onepassword          Cleanup only 1Password vaults
  --cleanup-github               Cleanup only GitHub repositories
  --cleanup-neon                 Cleanup only Neon databases
  --cleanup-caprover             Cleanup only CapRover apps
  --cleanup-vercel               Cleanup only Vercel projects
  --cleanup-netlify              Cleanup only Netlify sites
  --cleanup-resend               Cleanup only Resend API keys
  --interactive, -i              Interactive checkbox selection (ONLY way to delete)

CLEANUP FILTERS:
  --project <name>               Filter by project name (default: current directory)
  --filter <pattern>             Filter by arbitrary pattern
  --ids <id1,id2,...>            Cleanup specific resource IDs only

GENERAL OPTIONS:
  --env <dev|prod|all>           Environment selection (default: all)
  --verbose, -v                  Show detailed output
  --dry-run                      Show what would be done without making changes
  --force                        Force reprovisioning even if resources already exist
  --check-config                 Check credential configuration and show status
  --help, -h                     Show this help message

AUDIT EXAMPLES:
  # Audit both dev and prod vaults for a project
  npx provision-wasp-saas --audit --project my-app

  # Audit only production vault
  npx provision-wasp-saas --audit --project my-app --env prod

  # Show actual secret values (use with caution!)
  npx provision-wasp-saas --audit --project my-app --show-values

  # Show op:// reference paths
  npx provision-wasp-saas --audit --project my-app --verbose

PROVISIONING EXAMPLES:
  # Full provisioning (all components, both environments)
  npx provision-wasp-saas --provision

  # Just database for dev environment
  npx provision-wasp-saas --provision-neon --env dev

  # Database + hosting for production
  npx provision-wasp-saas --provision-neon --provision-caprover --provision-vercel --env prod

  # Test what would happen (dry-run)
  npx provision-wasp-saas --provision --dry-run --verbose

CLEANUP EXAMPLES:
  # List resources (DEFAULT - safest, read-only)
  npx provision-wasp-saas --cleanup-neon
  # Lists all Neon databases, no deletion possible

  # Interactive deletion (ONLY way to delete)
  npx provision-wasp-saas --cleanup-neon --interactive
  # Shows checkboxes, select with arrow keys + space, confirm to delete

  # Filter and list specific project (read-only)
  npx provision-wasp-saas --cleanup --project my-app --env dev
  # Lists only my-app dev environment resources

  # Interactive delete with filter (safest deletion)
  npx provision-wasp-saas --cleanup-vercel --filter "test-" --interactive
  # Shows only test-* projects in checkbox selection

  # Delete specific resources by ID (interactive)
  npx provision-wasp-saas --cleanup-neon --ids "proj_123,proj_456" --interactive
  # Shows only specified IDs in checkbox selection

  # Dry run to preview (no deletion)
  npx provision-wasp-saas --cleanup --project my-app --dry-run
  # Shows what would be deleted without actually deleting

CONFIGURATION:
  # Check what credentials are configured
  npx provision-wasp-saas --check-config
  # Shows status of all required credentials and how to configure missing ones

  # Option 1: Use 1Password references (RECOMMENDED)
  # Create .env file with op:// references
  cat > .env << 'EOF'
CAPROVER_URL="op://my-vault/CapRover/url"
CAPROVER_PASSWORD="op://my-vault/CapRover/password"
NEON_API_KEY="op://my-vault/Neon/api-key"
VERCEL_TOKEN="op://my-vault/Vercel/token"
NETLIFY_TOKEN="op://my-vault/Netlify/token"
RESEND_API_KEY="op://my-vault/Resend/api-key"
EOF

  # Run commands with op run (resolves references automatically)
  op run --env-file=".env" -- npx provision-wasp-saas --provision
  op run --env-file=".env" -- npx provision-wasp-saas --cleanup-caprover --interactive

  # Option 2: Export credentials directly
  export CAPROVER_URL="https://captain.your-domain.com"
  export CAPROVER_PASSWORD="your-password"
  export NEON_API_KEY="your-neon-api-key"
  export VERCEL_TOKEN="your-vercel-token"
  export NETLIFY_TOKEN="your-netlify-token"
  export RESEND_API_KEY="your-resend-api-key"
  npx provision-wasp-saas --provision

PREREQUISITES:
  - Wasp project already created (wasp new -t saas my-app)
  - 1Password CLI authenticated (op signin)
  - GitHub CLI authenticated (gh auth login)
  - Environment variables in .env.server.example and .env.client.example

WHAT IT DOES:
  1. Creates 1Password vaults (dev + prod)
  2. Provisions Neon PostgreSQL database
  3. Provisions CapRover backend hosting
  4. Provisions Vercel or Netlify frontend hosting
  5. Provisions Resend email service
  6. Generates secrets and stores in 1Password
  7. (Optional) Creates GitHub repository with CI/CD workflows
  8. (Optional) Generates .env files from 1Password

1PASSWORD VAULT STRUCTURE:
  After provisioning, secrets are organized in a hierarchical structure:

  op://my-project-prod/Auth/Secrets/jwt_secret
  op://my-project-prod/Neon/Database/database_url
  op://my-project-prod/Neon/Database/project_id
  op://my-project-prod/Neon/Connection/postgres_host
  op://my-project-prod/CapRover/Application/app_name
  op://my-project-prod/CapRover/Server/url
  op://my-project-prod/CapRover/Deployment/app_token
  op://my-project-prod/CapRover/URLs/api_url
  op://my-project-prod/Vercel/Project/project_id
  op://my-project-prod/Vercel/Credentials/token
  op://my-project-prod/Vercel/URLs/app_url
  op://my-project-prod/Netlify/Site/site_id
  op://my-project-prod/Netlify/Credentials/token
  op://my-project-prod/Netlify/URLs/app_url
  op://my-project-prod/Resend/Credentials/api_key
  op://my-project-prod/Resend/Configuration/email_from

  Each service is organized as:
  - Item name (e.g., "Neon", "CapRover", "Vercel")
  - Sections (e.g., "Database", "Credentials", "URLs")
  - Fields (e.g., "database_url", "api_key", "app_url")

  Use these references in your .env files with op run:
  DATABASE_URL="op://my-project-prod/Neon/Database/database_url"
  JWT_SECRET="op://my-project-prod/Auth/Secrets/jwt_secret"

For more information:
  https://github.com/gregflint/provision-wasp-saas
`);
}

function detectWaspProject(): { found: boolean; path: string } {
  const markers = ['main.wasp', '.wasproot'];

  // Check current directory first
  const cwdHasWasp = markers.some(file => fs.existsSync(path.join(process.cwd(), file)));
  if (cwdHasWasp) {
    return { found: true, path: process.cwd() };
  }

  // Check ./app subdirectory (common Wasp project structure)
  const appDir = path.join(process.cwd(), 'app');
  const appHasWasp = markers.some(file => fs.existsSync(path.join(appDir, file)));
  if (appHasWasp) {
    return { found: true, path: appDir };
  }

  return { found: false, path: process.cwd() };
}

/**
 * Detect the project name, handling the common Wasp "app" folder structure
 * If running from an "app" folder with a git repo parent, use the parent folder name
 */
function detectProjectName(): string {
  const cwd = process.cwd();
  const currentDirName = path.basename(cwd);

  // If not in an "app" folder, use current directory name
  if (currentDirName !== 'app') {
    return currentDirName;
  }

  // We're in an "app" folder - check if parent is a git repo
  const parentDir = path.dirname(cwd);
  const gitDir = path.join(parentDir, '.git');

  if (!fs.existsSync(gitDir)) {
    console.error('❌ Running from "app" folder but parent is not a git repository');
    console.error('   Expected structure:');
    console.error('   your-project/          <- git repo');
    console.error('     app/                 <- current directory');
    console.error('       main.wasp');
    console.error('');
    console.error('   Either:');
    console.error('   1. Run from the parent directory that contains .git');
    console.error('   2. Initialize a git repo in the parent: cd .. && git init');
    process.exit(1);
  }

  // Get the GitHub repo name from git remote
  try {
    const remoteUrl = execSync('git -C ' + JSON.stringify(parentDir) + ' remote get-url origin', {
      stdio: 'pipe',
      encoding: 'utf-8'
    }).trim();

    // Extract repo name from various git URL formats:
    // - https://github.com/user/repo.git
    // - git@github.com:user/repo.git
    // - https://github.com/user/repo
    const match = remoteUrl.match(/[:/]([^/]+)\/([^/]+?)(\.git)?$/);
    if (match) {
      const repoName = match[2];
      console.log(`✓ Detected project from parent git repo: ${repoName}`);
      return repoName;
    }
  } catch (e) {
    // No remote configured yet - that's okay, we'll use parent folder name
  }

  // Fall back to parent folder name
  const parentName = path.basename(parentDir);
  console.log(`✓ Using parent folder name as project: ${parentName}`);
  return parentName;
}

async function main() {
  const args = parseArgs();

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  if (args.checkConfig) {
    await checkConfig(args.verbose);
    process.exit(0);
  }

  if (args.init) {
    await initCommand({ verbose: args.verbose });
    process.exit(0);
  }

  if (args.audit) {
    await auditCommand({
      projectName: args.project,
      environment: args.env,
      verbose: args.verbose,
      showValues: args.showValues
    });
    process.exit(0);
  }

  if (args.updateWorkflows) {
    console.log('🔄 Updating workflow files...\n');
    await updateWorkflows({
      verbose: args.verbose,
      dryRun: args.dryRun,
      force: args.force
    });
    process.exit(0);
  }

  // Check for provisioning or cleanup flags
  const hasProvisionFlag = args.provision ||
    args.provisionOnePassword ||
    args.provisionNeon ||
    args.provisionCapRover ||
    args.provisionVercel ||
    args.provisionNetlify ||
    args.provisionResend ||
    args.provisionGitHub ||
    args.provisionEnv;

  const hasCleanupFlag = args.cleanup ||
    args.cleanupOnePassword ||
    args.cleanupGitHub ||
    args.cleanupNeon ||
    args.cleanupCapRover ||
    args.cleanupVercel ||
    args.cleanupNetlify ||
    args.cleanupResend;

  if (!hasProvisionFlag && !hasCleanupFlag) {
    console.error('❌ Missing provisioning or cleanup flag');
    console.log('');
    console.log('Run with --provision for provisioning or --cleanup for cleanup');
    console.log('');
    console.log('Run with --help for full usage information');
    process.exit(1);
  }

  if (hasProvisionFlag && hasCleanupFlag) {
    console.error('❌ Cannot run provisioning and cleanup together');
    console.log('');
    console.log('Run --provision or --cleanup, but not both');
    process.exit(1);
  }

  // Detect Wasp project (only required for provisioning, not cleanup)
  const waspDetection = detectWaspProject();

  if (hasProvisionFlag && !waspDetection.found) {
    console.error('❌ No Wasp project detected');
    console.error('   Looking for: main.wasp or .wasproot');
    console.error('   Searched in:');
    console.error('     - Current directory');
    console.error('     - ./app subdirectory');
    console.error('');
    console.error('   Run this from a Wasp project directory created with:');
    console.error('   wasp new -t saas my-app');
    process.exit(1);
  }

  // Change to Wasp directory if found in subdirectory
  if (waspDetection.found && waspDetection.path !== process.cwd()) {
    if (args.verbose) {
      console.log(`✓ Found Wasp project in: ${path.relative(process.cwd(), waspDetection.path)}/`);
    }
    process.chdir(waspDetection.path);
  }

  if (waspDetection.found) {
    console.log('✓ Wasp project detected');
  }

  // Check prerequisites
  const checks = [
    { name: 'op CLI', cmd: 'op --version' },
    { name: 'gh CLI', cmd: 'gh --version' },
    { name: 'git', cmd: 'git --version' },
    { name: 'wasp', cmd: 'wasp version' }
  ];

  for (const check of checks) {
    try {
      execSync(check.cmd, { stdio: 'ignore' });
      if (args.verbose) console.log(`✓ ${check.name} installed`);
    } catch {
      console.error(`❌ ${check.name} not found. Please install it first.`);
      process.exit(1);
    }
  }

  console.log('');

  try {
    if (hasCleanupFlag) {
      // CLEANUP MODE
      // Determine which components to cleanup
      const components: ProviderName[] = [];

      if (args.cleanup) {
        // Cleanup all components (excluding GitHub - use --cleanup-github explicitly)
        components.push('onepassword', 'neon', 'caprover', 'vercel', 'netlify', 'resend');
      } else {
        // Selective cleanup
        if (args.cleanupOnePassword) components.push('onepassword');
        if (args.cleanupGitHub) components.push('github');
        if (args.cleanupNeon) components.push('neon');
        if (args.cleanupCapRover) components.push('caprover');
        if (args.cleanupVercel) components.push('vercel');
        if (args.cleanupNetlify) components.push('netlify');
        if (args.cleanupResend) components.push('resend');
      }

      // Determine project name for filtering
      let projectName: string | undefined;
      if (args.project) {
        // Explicit --project flag
        projectName = args.project;
      } else if (waspDetection.found) {
        // Auto-detect from directory if in Wasp project
        projectName = detectProjectName();
      }
      // else: undefined (list all resources)

      // Parse environment filter
      const envSuffix = args.env === 'all' ? undefined : args.env;

      // Parse resource IDs
      const resourceIds = args.ids ? args.ids.split(',').map(id => id.trim()).filter(Boolean) : undefined;

      // Call cleanup with CleanupFunctions wrapped
      const cleanupFunctionsMap: Record<string, any> = {};
      for (const component of components) {
        cleanupFunctionsMap[component] = {
          listInstances: async (opts: any) => {
            const cleanupOpts = {
              projectName: opts.projectName,
              envSuffix: opts.envSuffix,
              filterPattern: opts.filterPattern,
              verbose: opts.verbose
            };
            return cleanupRegistry[component].listInstances(cleanupOpts);
          },
          deleteInstance: async (instanceId: string, opts: any) => {
            const cleanupOpts = {
              projectName: opts.projectName,
              envSuffix: opts.envSuffix,
              filterPattern: opts.filterPattern,
              verbose: opts.verbose
            };
            return cleanupRegistry[component].deleteInstance(instanceId, cleanupOpts);
          }
        };
      }

      // Run cleanup (list-only by default, interactive with --interactive for deletion)
      await cleanup(components, cleanupFunctionsMap, {
        projectName,
        envSuffix,
        filterPattern: args.filter,
        resourceIds,
        interactive: args.interactive,
        verbose: args.verbose,
        dryRun: args.dryRun
      });
    } else {
      // PROVISIONING MODE
      console.log('🚀 Starting infrastructure provisioning...');
      console.log('');

      // Detect project name
      const projectName = detectProjectName();

      // Determine which components to provision
      let components: ProviderName[] | undefined;
      let includeGitHub = false;
      let includeEnv = false;

      if (args.provision) {
        // Full provisioning - provision all components
        components = undefined; // undefined means all
        includeGitHub = true;
        includeEnv = true;
      } else {
        // Selective provisioning
        components = [];

        if (args.provisionOnePassword) components.push('onepassword');
        if (args.provisionNeon) components.push('neon');
        if (args.provisionCapRover) components.push('caprover');
        if (args.provisionVercel) components.push('vercel');
        if (args.provisionNetlify) components.push('netlify');
        if (args.provisionResend) components.push('resend');

        includeGitHub = args.provisionGitHub;
        includeEnv = args.provisionEnv;

        if (components.length === 0 && !includeGitHub && !includeEnv) {
          console.error('❌ No components selected for provisioning');
          process.exit(1);
        }
      }

      // Parse environments
      const environments: Array<'dev' | 'prod'> = args.env === 'all'
        ? ['dev', 'prod']
        : [args.env];

      await provision({
        projectName,
        components,
        includeGitHub,
        includeEnv,
        environments,
        verbose: args.verbose,
        dryRun: args.dryRun,
        force: args.force
      });
    }
  } catch (error) {
    console.error('');
    console.error(`❌ ${hasCleanupFlag ? 'Cleanup' : 'Provisioning'} failed:`);
    console.error(error instanceof Error ? error.message : String(error));

    if (args.verbose && error instanceof Error && error.stack) {
      console.error('');
      console.error('Stack trace:');
      console.error(error.stack);
    }

    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
