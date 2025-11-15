/**
 * Main provisioning orchestrator for Wasp/OpenSaaS projects
 * Coordinates all infrastructure providers with dependency management
 */

import path from 'node:path';
import { parseWaspEnv } from './wasp-parser.js';
import { ensureOpAuth, opEnsureVault } from './op-util.js';
import { createGitHubRepo, setupGitHubSecrets, copyWorkflowTemplates, copyScriptTemplates, copyCapRoverConfig } from './github-provision.js';
import { emitEnvFiles } from './env-emit.js';
import { provisionOnePassword } from './onepassword-provision.js';
import { providers, resolveDependencies, getExecutionOrder, ProviderName, InfraProviderName } from './providers.js';
import { rollback, collectRollbackActions, RollbackAction } from './rollback.js';
import { ProvisioningError } from './rollback.js';

export interface ProvisionOptions {
  // Component selection (undefined = all providers)
  components?: ProviderName[];

  // Also include github and env
  includeGitHub?: boolean;
  includeEnv?: boolean;

  // Environment selection
  environments?: Array<'dev' | 'prod'>;

  // Flags
  verbose?: boolean;
  dryRun?: boolean;
  force?: boolean; // Force reprovisioning even if resources exist

  // Auto-detected
  projectName?: string;
  projectDir?: string;
}

/**
 * Main provisioning function
 * Orchestrates all infrastructure provisioning with dependency resolution
 */
export async function provision(options: ProvisionOptions = {}): Promise<void> {
  const {
    components,
    includeGitHub = false,
    includeEnv = false,
    environments = ['dev', 'prod'],
    verbose = false,
    dryRun = false,
    force = false,
    projectName: customProjectName,
    projectDir = process.cwd()
  } = options;

  const projectName = customProjectName || path.basename(projectDir);
  const rollbackActions: RollbackAction[] = [];

  if (verbose) {
    console.log('');
    console.log(`Project: ${projectName}`);
    console.log(`Directory: ${projectDir}`);
    console.log(`Environments: ${environments.join(', ')}`);
    console.log('');
  }

  // Determine which components to provision
  const requestedComponents = components || (['onepassword', 'neon', 'caprover', 'vercel', 'resend'] as ProviderName[]);
  const componentsToProvision = resolveDependencies(requestedComponents);

  if (verbose) {
    console.log(`Components to provision: ${componentsToProvision.join(', ')}`);
    if (includeGitHub) console.log('Will setup GitHub repository');
    if (includeEnv) console.log('Will emit environment files');
    console.log('');
  }

  try {
    // Parse Wasp environment requirements (for reference)
    if (verbose) {
      console.log('📋 Parsing Wasp environment configuration...');
      try {
        const envConfig = parseWaspEnv(projectDir);
        console.log(`  Found ${envConfig.serverVars.length} server variables`);
        console.log(`  Found ${envConfig.clientVars.length} client variables`);
      } catch (e: any) {
        console.warn(`  Warning: Could not parse Wasp env: ${e?.message || e}`);
      }
      console.log('');
    }

    // Phase 1: 1Password vaults (foundational)
    if (componentsToProvision.includes('onepassword')) {
      console.log('🔐 Setting up 1Password vaults...');

      if (!dryRun) {
        ensureOpAuth();
      }

      for (const env of environments) {
        const vaultName = `${projectName}-${env}`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-');

        if (verbose) {
          console.log(`  Environment: ${env}`);
        }

        const { result, rollbackActions: opRollback } = await provisionOnePassword({
          vaultName,
          projectName,
          envSuffix: env,
          verbose,
          dryRun
        });

        rollbackActions.push(...opRollback);
      }

      console.log('');
    }

    // Phase 2: Infrastructure providers (can run in parallel per environment)
    const infraProviders: InfraProviderName[] = ['neon', 'caprover', 'vercel', 'resend'];
    const toProvision = infraProviders.filter(p => componentsToProvision.includes(p));

    if (toProvision.length > 0) {
      console.log('🚀 Provisioning infrastructure...');
      console.log('');

      for (const env of environments) {
        if (verbose && environments.length > 1) {
          console.log(`Environment: ${env}`);
        }

        // Run all providers for this environment in parallel
        const tasks = toProvision.map(async (providerName) => {
          try {
            const { result, rollbackActions: providerRollback } = await providers[providerName]({
              projectName,
              envSuffix: env,
              verbose,
              dryRun,
              force
            });

            rollbackActions.push(...providerRollback);

            return { providerName, success: true, result };
          } catch (e: any) {
            throw new ProvisioningError(
              `${providerName} provisioning failed: ${e?.message || e}`,
              providerName,
              rollbackActions
            );
          }
        });

        await Promise.all(tasks);

        if (verbose && environments.length > 1) {
          console.log('');
        }
      }

      if (!verbose || environments.length === 1) {
        console.log('');
      }
    }

    // Phase 3: GitHub (sequential, after infrastructure)
    if (includeGitHub) {
      console.log('📦 Setting up GitHub repository...');

      if (!dryRun) {
        try {
          await createGitHubRepo({ projectName, verbose });

          // Check if CapRover was provisioned so we can update env vars
          const caproverProvisioned = componentsToProvision.includes('caprover');

          const { rollbackActions: githubRollback } = await setupGitHubSecrets({
            projectName,
            environments,
            verbose,
            force,
            updateCapRover: caproverProvisioned
          });
          rollbackActions.push(...githubRollback);

          await copyWorkflowTemplates({ projectName, verbose });
          await copyScriptTemplates({ projectName, verbose });
          await copyCapRoverConfig({ verbose });

          if (verbose) {
            console.log(`  ✓ GitHub repository configured`);
            console.log(`  ✓ Workflow templates copied`);
            console.log(`  ✓ Script templates copied`);
            console.log(`  ✓ CapRover configuration copied`);
          } else {
            console.log(`  ✓ GitHub: ${projectName}`);
          }
        } catch (e: any) {
          throw new ProvisioningError(
            `GitHub setup failed: ${e?.message || e}`,
            'github',
            rollbackActions
          );
        }
      } else {
        console.log(`  [DRY RUN] Would setup GitHub repository`);
      }

      console.log('');
    }

    // Phase 4: Environment files (last, reads from vaults)
    if (includeEnv) {
      console.log('📝 Generating environment files...');

      for (const env of environments) {
        const vaultName = `${projectName}-${env}`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-');

        try {
          await emitEnvFiles({
            projectName,
            envSuffix: env,
            vaultName,
            verbose,
            dryRun
          });
        } catch (e: any) {
          console.warn(`  Warning: Failed to emit env files for ${env}: ${e?.message || e}`);
        }
      }

      console.log('');
    }

    // Success!
    console.log('✅ Provisioning complete!');
    console.log('');

    if (!dryRun) {
      console.log('Next steps:');
      console.log('  1. Review generated secrets in 1Password vaults');
      console.log('  2. Update any placeholder values as needed');

      if (includeGitHub) {
        console.log('  3. Push your code to trigger the first deployment:');
        console.log(`     git remote add origin https://github.com/YOUR_USERNAME/${projectName}.git`);
        console.log('     git push -u origin Development');
      } else {
        console.log('  3. Set up GitHub with: --provision-github');
      }

      console.log('');
    }
  } catch (error) {
    // Handle provisioning errors with rollback
    if (error instanceof ProvisioningError) {
      console.error('');
      console.error(`❌ ${error.component} provisioning failed:`);
      console.error(`   ${error.message}`);
      console.error('');

      if (!dryRun && rollbackActions.length > 0) {
        await rollback(rollbackActions, verbose);
      }

      throw error;
    } else {
      // Unexpected error
      console.error('');
      console.error('❌ Unexpected error during provisioning:');
      console.error(error instanceof Error ? error.message : String(error));
      console.error('');

      if (!dryRun && rollbackActions.length > 0) {
        await rollback(rollbackActions, verbose);
      }

      throw error;
    }
  }
}
