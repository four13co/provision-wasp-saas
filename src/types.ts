/**
 * Shared TypeScript interfaces for provision-wasp-saas
 */

/**
 * Options passed to all provider functions
 */
export interface ProvisionOptions {
  projectName: string;
  envSuffix: 'dev' | 'prod';
  verbose?: boolean;
  dryRun?: boolean;
}

/**
 * Result returned from Neon database provisioning
 */
export interface NeonResult {
  projectId: string;
  databaseUrl: string;
}

/**
 * Result returned from CapRover backend provisioning
 */
export interface CapRoverResult {
  appName: string;
  appToken: string;
  apiUrl: string;
}

/**
 * A single Vercel project (dev or prod)
 */
export interface VercelProject {
  id: string;
  name: string;
  url: string;
}

/**
 * Result returned from Vercel frontend provisioning
 */
export interface VercelResult {
  project: VercelProject;
}

/**
 * A single Netlify site (dev or prod)
 */
export interface NetlifySite {
  id: string;
  name: string;
  url: string;
}

/**
 * Result returned from Netlify frontend provisioning
 */
export interface NetlifyResult {
  site: NetlifySite;
}

/**
 * A Resend API key (dev or prod)
 */
export interface ResendKey {
  id: string;
  token: string;
  name: string;
}

/**
 * Result returned from Resend email provisioning
 */
export interface ResendResult {
  key: ResendKey;
}

/**
 * Options for 1Password vault provisioning
 */
export interface OnePasswordOptions {
  vaultName: string;
  projectName: string;
  envSuffix: 'dev' | 'prod';
  verbose?: boolean;
  dryRun?: boolean;
}

/**
 * Result returned from 1Password vault provisioning
 */
export interface OnePasswordResult {
  vaultName: string;
  vaultId?: string;
}

/**
 * Options for environment file generation
 */
export interface EnvEmitOptions {
  projectName: string;
  envSuffix: 'dev' | 'prod';
  vaultName: string;
  verbose?: boolean;
  dryRun?: boolean;
}

/**
 * Options for GitHub repository provisioning
 */
export interface GitHubOptions {
  projectName: string;
  vaultDev: string;
  vaultProd: string;
  verbose?: boolean;
  dryRun?: boolean;
}

/**
 * Result returned from GitHub provisioning
 */
export interface GitHubResult {
  repoUrl: string;
  repoName: string;
}

/**
 * A single rollback action that can be executed
 */
export interface RollbackAction {
  component: string;
  description: string;
  execute: () => Promise<void>;
}

/**
 * Options for cleanup operations
 */
export interface CleanupOptions {
  projectName?: string; // undefined = list all resources (no filtering)
  envSuffix?: 'dev' | 'prod'; // undefined = both environments
  filterPattern?: string; // arbitrary pattern for filtering
  resourceIds?: string[]; // specific resource IDs to delete
  interactive?: boolean; // interactive checkbox selection mode (ONLY way to delete)
  verbose?: boolean;
  dryRun?: boolean;
}

/**
 * A single provisioned instance that can be cleaned up
 */
export interface ProviderInstance {
  id: string;
  name: string;
  environment?: 'dev' | 'prod' | 'unknown';
  metadata?: Record<string, any>;
  createdAt?: string;
}

/**
 * Result from listing instances
 */
export interface ListInstancesResult {
  instances: ProviderInstance[];
  total: number;
}

/**
 * Result from deleting an instance
 */
export interface DeleteInstanceResult {
  id: string;
  name: string;
  success: boolean;
  error?: string;
}

/**
 * Overall cleanup result
 */
export interface CleanupResult {
  component: string;
  deleted: DeleteInstanceResult[];
  failed: DeleteInstanceResult[];
  total: number;
}
