/**
 * Interactive resource selection UI
 * Provides checkbox-based selection for safe resource deletion
 */

import { checkbox, confirm } from '@inquirer/prompts';
import { ProviderInstance } from './types.js';

export interface SelectionResult {
  selected: ProviderInstance[];
  cancelled: boolean;
}

/**
 * Interactive checkbox selection for resources
 * Returns selected instances or empty array if cancelled
 */
export async function selectResources(
  component: string,
  instances: ProviderInstance[]
): Promise<SelectionResult> {
  if (instances.length === 0) {
    return { selected: [], cancelled: false };
  }

  // Create choices for checkbox prompt
  const choices = instances.map((inst, idx) => {
    const envLabel = inst.environment ? ` [${inst.environment}]` : '';
    const createdLabel = inst.createdAt ? ` (Created: ${new Date(inst.createdAt).toLocaleDateString()})` : '';

    return {
      name: `${inst.name}${envLabel}${createdLabel}`,
      value: inst.id,
      description: `ID: ${inst.id}`,
      checked: false
    };
  });

  try {
    // Checkbox selection
    const selectedIds = await checkbox({
      message: `Select ${component} resources to delete`,
      choices,
      pageSize: 15,
      instructions: '\n  Navigate: ↑↓  |  Select: Space  |  All: Ctrl+A  |  Confirm: Enter  |  Exit: Esc\n',
      loop: false,
      required: false
    });

    if (selectedIds.length === 0) {
      console.log('\n  No resources selected');
      return { selected: [], cancelled: true };
    }

    // Map back to instances
    const selected = instances.filter(inst => selectedIds.includes(inst.id));

    // Show selection summary
    console.log(`\n✓ Selected ${selected.length} resource(s) for deletion:`);
    selected.forEach(inst => {
      const envLabel = inst.environment ? ` [${inst.environment}]` : '';
      console.log(`  - ${inst.name}${envLabel} (${inst.id})`);
    });
    console.log('');

    // Extra warning for large deletions
    if (selected.length > 5) {
      console.log(`  ⚠️  WARNING: You are about to delete ${selected.length} resources!`);
      console.log('');
    }

    // Confirmation
    try {
      const confirmed = await confirm({
        message: `Are you SURE you want to delete these ${selected.length} resource(s)?`,
        default: false
      });

      if (!confirmed) {
        console.log('  Deletion cancelled');
        return { selected: [], cancelled: true };
      }
    } catch (confirmError) {
      // Handle Escape/Ctrl+C during confirmation - exit the program
      console.log('\n  Operation cancelled');
      process.exit(0);
    }

    return { selected, cancelled: false };

  } catch (error) {
    // Handle Escape/Ctrl+C - exit the program cleanly
    console.log('\n  Operation cancelled');
    process.exit(0);
  }
}
