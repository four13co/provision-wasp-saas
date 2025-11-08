/**
 * Cleanup orchestrator for removing provisioned infrastructure
 * Provides component-level cleanup with instance listing and deletion
 */

import { ProviderName, InfraProviderName } from './providers.js';
import { CleanupOptions, CleanupResult, ProviderInstance, DeleteInstanceResult } from './types.js';
import { selectResources } from './interactive-select.js';
import readline from 'node:readline';

export interface CleanupFunction {
  listInstances: (options: CleanupOptions) => Promise<ProviderInstance[]>;
  deleteInstance: (instanceId: string, options: CleanupOptions) => Promise<DeleteInstanceResult>;
}

/**
 * Ask user for confirmation
 */
async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(`${message} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

/**
 * Cleanup a single component
 */
export async function cleanupComponent(
  component: ProviderName,
  cleanupFn: CleanupFunction,
  options: CleanupOptions
): Promise<CleanupResult> {
  const { verbose, dryRun, projectName, filterPattern, resourceIds } = options;

  console.log(`\n🔍 Scanning ${component} instances...`);

  // List instances
  const allInstances = await cleanupFn.listInstances(options);

  // Filter by specific IDs if provided
  const instances = resourceIds && resourceIds.length > 0
    ? allInstances.filter(inst => resourceIds.includes(inst.id))
    : allInstances;

  if (instances.length === 0) {
    if (resourceIds && resourceIds.length > 0) {
      console.log(`  No matching ${component} instances found for specified IDs`);
    } else if (!projectName && !filterPattern) {
      console.log(`  No ${component} instances found`);
    } else {
      console.log(`  No ${component} instances found matching filter`);
    }
    return {
      component,
      deleted: [],
      failed: [],
      total: 0
    };
  }

  // Display filter status
  if (!projectName && !filterPattern && !resourceIds) {
    console.log(`  ⚠️  Showing ALL ${component} resources (no filter active)\n`);
  } else if (resourceIds && resourceIds.length > 0) {
    console.log(`  Filter: Specific IDs (${resourceIds.length} requested)\n`);
  } else if (filterPattern) {
    console.log(`  Filter: Pattern "${filterPattern}"\n`);
  } else if (projectName) {
    console.log(`  Filter: Project "${projectName}"${options.envSuffix ? ` (${options.envSuffix})` : ''}\n`);
  }

  // Display instances
  console.log(`  Found ${instances.length} instance(s):\n`);
  instances.forEach((inst, idx) => {
    const envLabel = inst.environment ? ` [${inst.environment}]` : '';
    console.log(`  ${idx + 1}. ${inst.name}${envLabel}`);
    console.log(`     ID: ${inst.id}`);
    if (inst.createdAt) {
      console.log(`     Created: ${inst.createdAt}`);
    }
    if (inst.metadata && verbose) {
      console.log(`     Metadata: ${JSON.stringify(inst.metadata, null, 2).split('\n').join('\n     ')}`);
    }
    console.log('');
  });

  // Determine deletion mode
  const interactive = options.interactive || false;

  // LIST-ONLY MODE (default): Just display, no deletion
  if (!interactive && !dryRun) {
    console.log('  ℹ️  List-only mode (default). Use --interactive to delete resources.\n');
    return {
      component,
      deleted: [],
      failed: [],
      total: 0
    };
  }

  // INTERACTIVE MODE: Checkbox selection (ONLY way to delete)
  let instancesToDelete = instances;

  if (interactive && !dryRun) {
    console.log(''); // Add spacing before interactive prompt
    const selection = await selectResources(component, instances);

    if (selection.cancelled || selection.selected.length === 0) {
      return {
        component,
        deleted: [],
        failed: [],
        total: 0
      };
    }

    instancesToDelete = selection.selected;
  }

  if (dryRun) {
    console.log(`  [DRY RUN] Would delete ${instancesToDelete.length} instance(s)`);
    return {
      component,
      deleted: instancesToDelete.map(inst => ({
        id: inst.id,
        name: inst.name,
        success: true
      })),
      failed: [],
      total: instancesToDelete.length
    };
  }

  // Delete instances
  console.log(`\n  Deleting ${instancesToDelete.length} instance(s)...\n`);

  const deleted: DeleteInstanceResult[] = [];
  const failed: DeleteInstanceResult[] = [];

  for (const inst of instancesToDelete) {
    try {
      console.log(`  Deleting ${inst.name} (${inst.id})...`);
      const result = await cleanupFn.deleteInstance(inst.id, options);

      if (result.success) {
        console.log(`  ✓ Deleted ${inst.name}`);
        deleted.push(result);
      } else {
        console.log(`  ✗ Failed to delete ${inst.name}: ${result.error}`);
        failed.push(result);
      }
    } catch (error: any) {
      const failResult: DeleteInstanceResult = {
        id: inst.id,
        name: inst.name,
        success: false,
        error: error?.message || String(error)
      };
      console.log(`  ✗ Failed to delete ${inst.name}: ${failResult.error}`);
      failed.push(failResult);
    }
  }

  console.log('');
  console.log(`  Deleted: ${deleted.length}`);
  console.log(`  Failed: ${failed.length}`);

  return {
    component,
    deleted,
    failed,
    total: instancesToDelete.length
  };
}

/**
 * Main cleanup function
 * Orchestrates cleanup across multiple components
 */
export async function cleanup(
  components: ProviderName[],
  cleanupRegistry: Record<string, CleanupFunction>,
  options: CleanupOptions
): Promise<CleanupResult[]> {
  const { verbose, projectName, filterPattern, resourceIds } = options;

  console.log('');
  console.log('🧹 Starting infrastructure cleanup...');
  console.log('');

  // Show filter status
  const isListOnly = !options.interactive && !options.dryRun;

  if (resourceIds && resourceIds.length > 0) {
    console.log(`Mode: Selective ${isListOnly ? 'listing' : 'cleanup'} (${resourceIds.length} IDs specified)`);
  } else if (!projectName && !filterPattern) {
    console.log(`Mode: Global ${isListOnly ? 'listing' : 'cleanup'} (ALL resources)`);
    if (!isListOnly) {
      console.log(`⚠️  WARNING: No project filter active - will list/delete ALL resources!`);
    } else {
      console.log(`ℹ️  No project filter - showing all resources. Use --project to filter.`);
    }
  } else if (filterPattern) {
    console.log(`Mode: Filtered ${isListOnly ? 'listing' : 'cleanup'} (pattern: "${filterPattern}")`);
  } else if (projectName) {
    console.log(`Mode: Project-scoped ${isListOnly ? 'listing' : 'cleanup'}`);
    console.log(`Project: ${projectName}`);
    if (options.envSuffix) {
      console.log(`Environment: ${options.envSuffix}`);
    } else {
      console.log('Environment: all');
    }
  }

  console.log('');

  const results: CleanupResult[] = [];

  for (const component of components) {
    const cleanupFn = cleanupRegistry[component];

    if (!cleanupFn) {
      console.log(`\n⚠️  No cleanup function available for ${component}`);
      continue;
    }

    try {
      const result = await cleanupComponent(component, cleanupFn, options);
      results.push(result);
    } catch (error: any) {
      console.error(`\n❌ Failed to cleanup ${component}:`);
      console.error(`   ${error?.message || String(error)}`);

      if (verbose && error instanceof Error && error.stack) {
        console.error(`   Stack: ${error.stack}`);
      }

      results.push({
        component,
        deleted: [],
        failed: [{
          id: 'unknown',
          name: component,
          success: false,
          error: error?.message || String(error)
        }],
        total: 0
      });
    }
  }

  // Summary
  const totalDeleted = results.reduce((sum, r) => sum + r.deleted.length, 0);
  const totalFailed = results.reduce((sum, r) => sum + r.failed.length, 0);

  console.log('');
  console.log('✅ Cleanup complete!');
  console.log('');
  console.log(`Total deleted: ${totalDeleted}`);
  console.log(`Total failed: ${totalFailed}`);
  console.log('');

  return results;
}
