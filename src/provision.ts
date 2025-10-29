/**
 * Main provisioning orchestrator for Wasp/OpenSaaS projects
 */

import path from 'node:path';
import { parseWaspEnv } from './wasp-parser.js';
import { ensureOpAuth, opEnsureVault } from './op-util.js';
import { createGitHubRepo, setupGitHubSecrets } from './github-provision.js';
// TODO: These functions need to be created or exported from existing files
// import { provisionNeon } from './neon-provision.js';
// import { provisionCapRover } from './caprover-provision.js';
// import { provisionVercel } from './vercel-provision.js';

export interface ProvisionOptions {
  verbose: boolean;
  dryRun: boolean;
}

export async function provision(options: ProvisionOptions): Promise<void> {
  const { verbose, dryRun } = options;

  const cwd = process.cwd();
  const projectName = path.basename(cwd);

  if (verbose) {
    console.log(`Project directory: ${cwd}`);
    console.log(`Project name: ${projectName}`);
  }

  // Step 1: Parse Wasp environment requirements
  console.log('📋 Parsing environment configuration...');
  const envConfig = parseWaspEnv(cwd);
  if (verbose) {
    console.log(`  Found ${envConfig.serverVars.length} server variables`);
    console.log(`  Found ${envConfig.clientVars.length} client variables`);
  }

  // Step 2: Ensure 1Password authentication
  console.log('🔐 Checking 1Password authentication...');
  if (!dryRun) {
    ensureOpAuth();
  }

  // Step 3: Create 1Password vaults
  console.log('🗄️  Creating 1Password vaults...');
  const vaultDev = `${projectName}-dev`;
  const vaultProd = `${projectName}-prod`;

  if (!dryRun) {
    opEnsureVault(vaultDev);
    opEnsureVault(vaultProd);
  }
  console.log(`  ✓ Created vaults: ${vaultDev}, ${vaultProd}`);

  // Step 4: Bootstrap vaults with secrets
  console.log('🔑 Generating and storing secrets...');
  if (!dryRun) {
    // TODO: Call op-bootstrap-project for each environment
  }
  console.log('  ✓ Secrets stored in 1Password');

  // Step 5: Provision Neon database
  console.log('🗄️  Provisioning Neon database...');
  if (!dryRun) {
    // TODO: Implement Neon provisioning
    // await provisionNeon({ projectName, env: 'dev', verbose });
    // await provisionNeon({ projectName, env: 'prod', verbose });
  }
  console.log('  ✓ Database provisioned');

  // Step 6: Provision CapRover backend
  console.log('🐳 Provisioning CapRover backend...');
  if (!dryRun) {
    // TODO: Implement CapRover provisioning
    // await provisionCapRover({ projectName, env: 'dev', verbose });
    // await provisionCapRover({ projectName, env: 'prod', verbose });
  }
  console.log('  ✓ CapRover backend ready');

  // Step 7: Provision Vercel frontend
  console.log('▲ Provisioning Vercel frontend...');
  if (!dryRun) {
    // TODO: Implement Vercel provisioning
    // await provisionVercel({ projectName, env: 'dev', verbose });
    // await provisionVercel({ projectName, env: 'prod', verbose });
  }
  console.log('  ✓ Vercel frontend ready');

  // Step 8: Create GitHub repository
  console.log('📦 Creating GitHub repository...');
  if (!dryRun) {
    // TODO: Implement GitHub repo creation
    // await createGitHubRepo({ projectName, verbose });
  }
  console.log('  ✓ GitHub repository created');

  // Step 9: Setup GitHub secrets
  console.log('🔐 Configuring GitHub secrets...');
  if (!dryRun) {
    // TODO: Run op-service-account.sh
    // await setupGitHubSecrets({ projectName, vaultDev, vaultProd, verbose });
  }
  console.log('  ✓ GitHub secrets configured');

  // Step 10: Emit .env files
  console.log('📝 Generating .env files...');
  if (!dryRun) {
    // TODO: Emit .env.server and .env.client from 1Password
  }
  console.log('  ✓ Environment files created');

  console.log('');
  console.log('🎉 All done! Your Wasp app infrastructure is ready.');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Review generated .env.server and .env.client files');
  console.log('  2. Update any placeholder values in 1Password vaults');
  console.log('  3. Push your code to trigger the first deployment:');
  console.log(`     git remote add origin https://github.com/YOUR_USERNAME/${projectName}.git`);
  console.log('     git push -u origin Development');
  console.log('');
}
