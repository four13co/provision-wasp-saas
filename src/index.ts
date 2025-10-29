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

interface CliArgs {
  provision: boolean;
  verbose: boolean;
  help: boolean;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  return {
    provision: args.includes('--provision'),
    verbose: args.includes('--verbose') || args.includes('-v'),
    help: args.includes('--help') || args.includes('-h'),
    dryRun: args.includes('--dry-run')
  };
}

function showHelp() {
  console.log(`
provision-wasp-saas

Infrastructure provisioning for Wasp/OpenSaaS projects.

USAGE:
  cd my-wasp-app
  npx provision-wasp-saas --provision [options]

OPTIONS:
  --provision      Run full infrastructure provisioning
  --verbose, -v    Show detailed output
  --dry-run        Show what would be done without making changes
  --help, -h       Show this help message

PREREQUISITES:
  - Wasp project already created (wasp new -t saas my-app)
  - 1Password CLI authenticated (op signin)
  - GitHub CLI authenticated (gh auth login)
  - Required environment variables in .env.server.example and .env.client.example

WHAT IT DOES:
  1. Detects Wasp project structure
  2. Creates 1Password vaults (dev + prod)
  3. Provisions Neon database
  4. Provisions CapRover backend hosting
  5. Provisions Vercel frontend hosting
  6. Generates secrets and stores in 1Password
  7. Creates GitHub repository with CI/CD workflows
  8. Deploys initial version

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

  if (!args.provision) {
    console.error('❌ Missing required flag: --provision');
    console.log('Run with --help for usage information');
    process.exit(1);
  }

  // Detect Wasp project
  if (!detectWaspProject()) {
    console.error('❌ No Wasp project detected in current directory');
    console.error('   Looking for: main.wasp or .wasproot');
    console.error('');
    console.error('   Run this from a Wasp project directory created with:');
    console.error('   wasp new -t saas my-app');
    process.exit(1);
  }

  console.log('✓ Wasp project detected');

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
  console.log('🚀 Starting infrastructure provisioning...');
  console.log('');

  try {
    await provision({ verbose: args.verbose, dryRun: args.dryRun });

    console.log('');
    console.log('✅ Provisioning complete!');
    console.log('');
  } catch (error) {
    console.error('');
    console.error('❌ Provisioning failed:');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
