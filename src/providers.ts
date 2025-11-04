/**
 * Provider registry and dependency resolution
 * Central registry of all infrastructure providers
 */

import { provisionNeon, listNeonInstances, deleteNeonInstance } from './neon-provision.js';
import { provisionCapRover, listCapRoverInstances, deleteCapRoverInstance } from './caprover-provision.js';
import { provisionVercel, listVercelInstances, deleteVercelInstance } from './vercel-provision.js';
import { provisionNetlify, listNetlifyInstances, deleteNetlifyInstance } from './netlify-provision.js';
import { provisionResend, listResendInstances, deleteResendInstance } from './resend-provision.js';
import { listOnePasswordInstances, deleteOnePasswordInstance } from './onepassword-provision.js';
import { listGitHubInstances, deleteGitHubInstance } from './github-provision.js';
import { ProvisionOptions, CleanupOptions, ProviderInstance, DeleteInstanceResult } from './types.js';

/**
 * Infrastructure provider names (excludes onepassword which has different signature)
 */
export type InfraProviderName = 'neon' | 'caprover' | 'vercel' | 'netlify' | 'resend';

/**
 * All provider names including onepassword and github
 * Note: 'onepassword' and 'github' have different function signatures and are called directly in provision.ts
 */
export type ProviderName = 'onepassword' | 'github' | InfraProviderName;

/**
 * Infrastructure provider function signatures (excludes onepassword)
 */
export interface ProviderRegistry {
  neon: typeof provisionNeon;
  caprover: typeof provisionCapRover;
  vercel: typeof provisionVercel;
  netlify: typeof provisionNetlify;
  resend: typeof provisionResend;
}

/**
 * Infrastructure provider registry mapping names to functions
 * (onepassword is excluded as it has a different signature)
 */
export const providers: ProviderRegistry = {
  neon: provisionNeon,
  caprover: provisionCapRover,
  vercel: provisionVercel,
  netlify: provisionNetlify,
  resend: provisionResend
};

/**
 * Cleanup function interface
 */
export interface CleanupFunctions {
  listInstances: (options: CleanupOptions) => Promise<ProviderInstance[]>;
  deleteInstance: (instanceId: string, options: CleanupOptions) => Promise<DeleteInstanceResult>;
}

/**
 * Cleanup registry for all providers (including onepassword and github)
 */
export const cleanupRegistry: Record<ProviderName, CleanupFunctions> = {
  onepassword: {
    listInstances: listOnePasswordInstances,
    deleteInstance: deleteOnePasswordInstance
  },
  github: {
    listInstances: listGitHubInstances,
    deleteInstance: deleteGitHubInstance
  },
  neon: {
    listInstances: listNeonInstances,
    deleteInstance: deleteNeonInstance
  },
  caprover: {
    listInstances: listCapRoverInstances,
    deleteInstance: deleteCapRoverInstance
  },
  vercel: {
    listInstances: listVercelInstances,
    deleteInstance: deleteVercelInstance
  },
  netlify: {
    listInstances: listNetlifyInstances,
    deleteInstance: deleteNetlifyInstance
  },
  resend: {
    listInstances: listResendInstances,
    deleteInstance: deleteResendInstance
  }
};

/**
 * Component dependency configuration
 * Each component lists what it requires and what is optional
 */
interface ComponentDependencies {
  requires: ProviderName[];
  optional: ProviderName[];
}

/**
 * Dependency graph showing which components require which others
 */
export const DEPENDENCIES: Record<string, ComponentDependencies> = {
  'onepassword': {
    requires: [],
    optional: []
  },
  'neon': {
    requires: ['onepassword'],
    optional: []
  },
  'caprover': {
    requires: ['onepassword'],
    optional: []
  },
  'vercel': {
    requires: ['onepassword'],
    optional: []
  },
  'netlify': {
    requires: ['onepassword'],
    optional: []
  },
  'resend': {
    requires: ['onepassword'],
    optional: []
  },
  'github': {
    requires: ['onepassword'],
    optional: ['neon', 'caprover', 'vercel', 'netlify']
  },
  'env': {
    requires: ['onepassword'],
    optional: ['neon', 'caprover', 'vercel', 'netlify', 'resend']
  }
};

/**
 * Resolve dependencies for requested components
 * Returns components in dependency order (foundation first)
 */
export function resolveDependencies(requested: ProviderName[]): ProviderName[] {
  const resolved = new Set<ProviderName>(requested);
  const queue = [...requested];

  // BFS to find all required dependencies
  while (queue.length > 0) {
    const component = queue.shift()!;
    const deps = DEPENDENCIES[component];

    if (deps) {
      for (const dep of deps.requires) {
        if (!resolved.has(dep)) {
          resolved.add(dep);
          queue.push(dep);
        }
      }
    }
  }

  // Return in dependency order (foundational components first)
  const order: ProviderName[] = ['onepassword', 'neon', 'caprover', 'vercel', 'netlify', 'resend'];
  return order.filter(c => resolved.has(c));
}

/**
 * Check if a component can run (all dependencies are satisfied)
 */
export function canRun(component: ProviderName, completed: Set<ProviderName>): boolean {
  const deps = DEPENDENCIES[component];
  if (!deps) return true;

  return deps.requires.every(dep => completed.has(dep));
}

/**
 * Get the execution order for a set of components
 * Returns an array of component groups that can run in parallel
 */
export function getExecutionOrder(components: ProviderName[]): ProviderName[][] {
  const resolved = resolveDependencies(components);
  const completed = new Set<ProviderName>();
  const groups: ProviderName[][] = [];

  while (completed.size < resolved.length) {
    const canRunNow = resolved.filter(c =>
      !completed.has(c) && canRun(c, completed)
    );

    if (canRunNow.length === 0) {
      // Should never happen with correct dependency graph
      throw new Error('Circular dependency detected or invalid dependency graph');
    }

    groups.push(canRunNow);
    canRunNow.forEach(c => completed.add(c));
  }

  return groups;
}
