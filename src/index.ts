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

interface CliArgs {
  // Full provisioning
  provision: boolean;

  // Individual components
  provisionOnePassword: boolean;
  provisionNeon: boolean;
  provisionCapRover: boolean;
  provisionVercel: boolean;
  provisionResend: boolean;
  provisionGitHub: boolean;
  provisionEnv: boolean;

  // Cleanup operations
  cleanup: boolean;
  cleanupOnePassword: boolean;
  cleanupNeon: boolean;
  cleanupCapRover: boolean;
  cleanupVercel: boolean;
  cleanupResend: boolean;
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
  checkConfig: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);

  // Helper to extract flag value
  const getFlagValue = (flag: string): string | undefined => {
    const arg = args.find(a => a.startsWith(`--${flag}`));
    if (arg) {
      return arg.split('=')[1] || args[args.indexOf(arg) + 1];
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
    provision: args.includes('--provision'),
    provisionOnePassword: args.includes('--provision-onepassword') || args.includes('--provision-1password'),
    provisionNeon: args.includes('--provision-neon'),
    provisionCapRover: args.includes('--provision-caprover'),
    provisionVercel: args.includes('--provision-vercel'),
    provisionResend: args.includes('--provision-resend'),
    provisionGitHub: args.includes('--provision-github'),
    provisionEnv: args.includes('--provision-env'),
    cleanup: args.includes('--cleanup'),
    cleanupOnePassword: args.includes('--cleanup-onepassword') || args.includes('--cleanup-1password'),
    cleanupNeon: args.includes('--cleanup-neon'),
    cleanupCapRover: args.includes('--cleanup-caprover'),
    cleanupVercel: args.includes('--cleanup-vercel'),
    cleanupResend: args.includes('--cleanup-resend'),
    interactive: args.includes('--interactive') || args.includes('-i'),
    project: getFlagValue('project'),
    filter: getFlagValue('filter'),
    ids: getFlagValue('ids'),
    env,
    verbose: args.includes('--verbose') || args.includes('-v'),
    help: args.includes('--help') || args.includes('-h'),
    dryRun: args.includes('--dry-run'),
    checkConfig: args.includes('--check-config')
  };
}

function showHelp() {
  console.log(`
provision-wasp-saas

Infrastructure provisioning for Wasp/OpenSaaS projects.

USAGE:
  cd my-wasp-app
  npx provision-wasp-saas [options]

PROVISIONING OPTIONS:
  --provision                    Run full infrastructure provisioning (all components)

  --provision-onepassword        Provision only 1Password vaults
  --provision-neon               Provision only Neon database
  --provision-caprover           Provision only CapRover backend hosting
  --provision-vercel             Provision only Vercel frontend hosting
  --provision-resend             Provision only Resend email service
  --provision-github             Setup GitHub repository with CI/CD
  --provision-env                Generate .env files from 1Password

CLEANUP OPTIONS:
  --cleanup                      Cleanup all provisioned infrastructure (list-only by default)
  --cleanup-onepassword          Cleanup only 1Password vaults
  --cleanup-neon                 Cleanup only Neon databases
  --cleanup-caprover             Cleanup only CapRover apps
  --cleanup-vercel               Cleanup only Vercel projects
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
  --check-config                 Check credential configuration and show status
  --help, -h                     Show this help message

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
  4. Provisions Vercel frontend hosting
  5. Provisions Resend email service
  6. Generates secrets and stores in 1Password
  7. (Optional) Creates GitHub repository with CI/CD workflows
  8. (Optional) Generates .env files from 1Password

For more information:
  https://github.com/gregflint/provision-wasp-saas
`);
}

function detectWaspProject(): boolean {
  const markers = ['main.wasp', '.wasproot'];
  return markers.some(file => fs.existsSync(path.join(process.cwd(), file)));
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

  // Check for provisioning or cleanup flags
  const hasProvisionFlag = args.provision ||
    args.provisionOnePassword ||
    args.provisionNeon ||
    args.provisionCapRover ||
    args.provisionVercel ||
    args.provisionResend ||
    args.provisionGitHub ||
    args.provisionEnv;

  const hasCleanupFlag = args.cleanup ||
    args.cleanupOnePassword ||
    args.cleanupNeon ||
    args.cleanupCapRover ||
    args.cleanupVercel ||
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
  const isWaspProject = detectWaspProject();

  if (hasProvisionFlag && !isWaspProject) {
    console.error('❌ No Wasp project detected in current directory');
    console.error('   Looking for: main.wasp or .wasproot');
    console.error('');
    console.error('   Run this from a Wasp project directory created with:');
    console.error('   wasp new -t saas my-app');
    process.exit(1);
  }

  if (isWaspProject) {
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

  // Check 1Password authentication
  try {
    execSync('op whoami', { stdio: 'ignore' });
    if (args.verbose) console.log('✓ 1Password authenticated');
  } catch {
    console.error('❌ 1Password not authenticated. Run: op signin');
    process.exit(1);
  }

  console.log('');

  try {
    if (hasCleanupFlag) {
      // CLEANUP MODE
      // Determine which components to cleanup
      const components: ProviderName[] = [];

      if (args.cleanup) {
        // Cleanup all components
        components.push('onepassword', 'neon', 'caprover', 'vercel', 'resend');
      } else {
        // Selective cleanup
        if (args.cleanupOnePassword) components.push('onepassword');
        if (args.cleanupNeon) components.push('neon');
        if (args.cleanupCapRover) components.push('caprover');
        if (args.cleanupVercel) components.push('vercel');
        if (args.cleanupResend) components.push('resend');
      }

      // Determine project name for filtering
      let projectName: string | undefined;
      if (args.project) {
        // Explicit --project flag
        projectName = args.project;
      } else if (isWaspProject) {
        // Auto-detect from directory if in Wasp project
        projectName = path.basename(process.cwd());
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
        components,
        includeGitHub,
        includeEnv,
        environments,
        verbose: args.verbose,
        dryRun: args.dryRun
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
