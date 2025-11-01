/**
 * Rollback mechanisms for failed provisioning
 *
 * When provisioning fails partway through, this module handles cleanup
 * of already-created resources to avoid leaving orphaned infrastructure.
 */

import { RollbackAction } from './types.js';

export { RollbackAction };

/**
 * Custom error class for provisioning failures
 * Includes rollback actions to clean up partial state
 */
export class ProvisioningError extends Error {
  public rollbackActions: RollbackAction[];
  public component: string;

  constructor(
    message: string,
    component: string,
    rollbackActions: RollbackAction[] = []
  ) {
    super(message);
    this.name = 'ProvisioningError';
    this.component = component;
    this.rollbackActions = rollbackActions;

    // Maintains proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ProvisioningError);
    }
  }
}

/**
 * Execute rollback actions in reverse order
 *
 * Rollback actions are executed in reverse order from how they were collected,
 * ensuring dependencies are cleaned up before their dependents.
 *
 * @param actions - Array of rollback actions to execute
 * @param verbose - Whether to log detailed output
 */
export async function rollback(
  actions: RollbackAction[],
  verbose: boolean = false
): Promise<void> {
  if (actions.length === 0) {
    if (verbose) {
      console.log('  No rollback actions to execute');
    }
    return;
  }

  console.log('');
  console.log('⚠️  Rolling back failed provisioning...');
  console.log('');

  // Execute in reverse order
  const reversedActions = [...actions].reverse();

  for (const action of reversedActions) {
    try {
      console.log(`  Rolling back: ${action.description}`);
      await action.execute();
      console.log(`  ✓ Rolled back ${action.component}`);
    } catch (error) {
      console.error(`  ✗ Failed to rollback ${action.component}:`);
      if (error instanceof Error) {
        console.error(`    ${error.message}`);
      } else {
        console.error(`    ${String(error)}`);
      }

      if (verbose && error instanceof Error && error.stack) {
        console.error(`    Stack: ${error.stack}`);
      }
    }
  }

  console.log('');
  console.log('⚠️  Rollback complete. Some manual cleanup may be required.');
  console.log('');
}

/**
 * Collect rollback actions from multiple sources
 * Useful for aggregating actions from multiple providers
 */
export function collectRollbackActions(
  ...actionArrays: RollbackAction[][]
): RollbackAction[] {
  return actionArrays.flat();
}

/**
 * Create a rollback action with standard format
 */
export function createRollbackAction(
  component: string,
  description: string,
  execute: () => Promise<void>
): RollbackAction {
  return {
    component,
    description,
    execute
  };
}
