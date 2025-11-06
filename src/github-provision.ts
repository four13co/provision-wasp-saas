/**
 * GitHub repository and CI/CD setup for Wasp projects
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupServiceAccountAndSecrets, getGitHubOwner } from './service-account.js';
import { RollbackAction } from './rollback.js';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface GitHubRepoOptions {
  projectName: string;
  verbose?: boolean;
}

export interface GitHubSecretsOptions {
  projectName: string;
  environments: Array<'dev' | 'prod'>;
  verbose?: boolean;
}

export async function createGitHubRepo(options: GitHubRepoOptions): Promise<void> {
  const { projectName, verbose } = options;

  // Check if repo already exists
  try {
    execSync(`gh repo view ${projectName}`, { stdio: 'ignore' });
    if (verbose) console.log(`  Repository ${projectName} already exists`);
    return;
  } catch {
    // Repo doesn't exist, create it
  }

  // Create repository
  execSync(
    `gh repo create ${projectName} --public --description "Wasp SaaS application" --clone=false`,
    { stdio: verbose ? 'inherit' : 'ignore' }
  );

  if (verbose) console.log(`  Created repository: ${projectName}`);

  // Find git root directory (check current dir and parent)
  let gitRoot = process.cwd();
  if (!fs.existsSync(path.join(gitRoot, '.git'))) {
    const parentDir = path.dirname(gitRoot);
    if (fs.existsSync(path.join(parentDir, '.git'))) {
      gitRoot = parentDir;
      if (verbose) console.log(`  Found git repository in parent directory: ${gitRoot}`);
    }
  }

  // Initialize git if not already initialized
  if (!fs.existsSync(path.join(gitRoot, '.git'))) {
    execSync('git init', { stdio: verbose ? 'inherit' : 'ignore', cwd: gitRoot });
    execSync('git branch -M Development', { stdio: verbose ? 'inherit' : 'ignore', cwd: gitRoot });
  }

  // Add remote
  try {
    execSync(`git remote add origin https://github.com/$(gh api user -q .login)/${projectName}.git`, {
      stdio: verbose ? 'inherit' : 'ignore',
      cwd: gitRoot
    });
  } catch {
    // Remote might already exist
  }

  // Create Production branch reference
  execSync('git branch Production', { stdio: verbose ? 'inherit' : 'ignore', cwd: gitRoot });

  if (verbose) console.log('  Initialized git with Development and Production branches');
}

export async function setupGitHubSecrets(options: GitHubSecretsOptions): Promise<{ rollbackActions: RollbackAction[] }> {
  const { projectName, environments, verbose } = options;
  const rollbackActions: RollbackAction[] = [];

  // Get GitHub owner and construct repo full name
  const owner = getGitHubOwner();
  const repo = `${owner}/${projectName}`;

  if (verbose) {
    console.log(`  Setting up GitHub secrets for ${repo}...`);
  }

  // Create service account and GitHub secrets for each environment
  for (const env of environments) {
    const vaultName = `${projectName}-${env}`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-');

    if (verbose) {
      console.log(`  Creating service account for ${env}...`);
    }

    try {
      const { rollbackActions: envRollback } = await setupServiceAccountAndSecrets({
        projectName,
        environment: env,
        vaultName,
        repo,
        verbose
      });

      rollbackActions.push(...envRollback);
    } catch (error: any) {
      throw new Error(`Failed to setup service account for ${env}: ${error.message}`);
    }
  }

  if (verbose) {
    console.log(`  ✓ Service accounts created (${environments.length})`);
    console.log('  ✓ GitHub secrets configured');
  }

  return { rollbackActions };
}

export async function copyWorkflowTemplates(options: { projectName: string; verbose?: boolean }): Promise<void> {
  const { projectName, verbose } = options;

  // Find git root directory (check current dir and parent)
  let gitRoot = process.cwd();
  if (!fs.existsSync(path.join(gitRoot, '.git'))) {
    const parentDir = path.dirname(gitRoot);
    if (fs.existsSync(path.join(parentDir, '.git'))) {
      gitRoot = parentDir;
      if (verbose) console.log(`  Found git repository in parent directory: ${gitRoot}`);
    }
  }

  // Create .github/workflows directory at git root
  const workflowsDir = path.join(gitRoot, '.github', 'workflows');
  fs.mkdirSync(workflowsDir, { recursive: true });

  // Get template directory
  const templatesDir = path.join(__dirname, '../templates/workflows');

  if (!fs.existsSync(templatesDir)) {
    throw new Error(`Workflow templates not found: ${templatesDir}`);
  }

  // Copy and customize workflow files
  const templates = fs.readdirSync(templatesDir).filter(f => f.endsWith('.yml'));

  if (verbose) {
    console.log(`  Copying workflows to: ${workflowsDir}`);
  }

  for (const template of templates) {
    const templatePath = path.join(templatesDir, template);
    const targetPath = path.join(workflowsDir, template);

    let content = fs.readFileSync(templatePath, 'utf-8');

    // Replace placeholders
    content = content.replace(/\{\{PROJECT_NAME\}\}/g, projectName);

    fs.writeFileSync(targetPath, content);

    if (verbose) console.log(`  ✓ Copied ${template}`);
  }

  if (!verbose) {
    console.log(`  ✓ Copied ${templates.length} workflow files to .github/workflows/`);
  }
}

/**
 * Copy script templates to user's project
 */
export async function copyScriptTemplates(options: { projectName: string; verbose?: boolean }): Promise<void> {
  const { projectName, verbose } = options;

  // Find git root directory (check current dir and parent)
  let gitRoot = process.cwd();
  if (!fs.existsSync(path.join(gitRoot, '.git'))) {
    const parentDir = path.dirname(gitRoot);
    if (fs.existsSync(path.join(parentDir, '.git'))) {
      gitRoot = parentDir;
      if (verbose) console.log(`  Found git repository in parent directory: ${gitRoot}`);
    }
  }

  // Create scripts directory at git root
  const scriptsDir = path.join(gitRoot, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });

  // Get template directory
  const templatesDir = path.join(__dirname, '../templates/scripts');

  if (!fs.existsSync(templatesDir)) {
    throw new Error(`Script templates not found: ${templatesDir}`);
  }

  // Copy script files
  const scripts = fs.readdirSync(templatesDir).filter(f => f.endsWith('.js'));

  if (verbose) {
    console.log(`  Copying scripts to: ${scriptsDir}`);
  }

  for (const script of scripts) {
    const templatePath = path.join(templatesDir, script);
    const targetPath = path.join(scriptsDir, script);

    let content = fs.readFileSync(templatePath, 'utf-8');

    // Replace placeholders if any (currently none, but keeping for consistency)
    content = content.replace(/\{\{PROJECT_NAME\}\}/g, projectName);

    fs.writeFileSync(targetPath, content);

    if (verbose) console.log(`  ✓ Copied ${script}`);
  }

  if (!verbose) {
    console.log(`  ✓ Copied ${scripts.length} script files to scripts/`);
  }
}

/**
 * List all GitHub repositories for cleanup
 */
export async function listGitHubInstances(
  options: { projectName?: string; envSuffix?: 'dev' | 'prod'; filterPattern?: string; verbose?: boolean }
): Promise<Array<{ id: string; name: string; environment?: 'dev' | 'prod' | 'unknown'; metadata?: any; createdAt?: string }>> {
  const { projectName, filterPattern, verbose } = options;

  try {
    // Try to detect organization from current repo, otherwise use authenticated user
    let owner: string;
    try {
      owner = execSync('gh repo view --json owner -q .owner.login', { stdio: 'pipe', encoding: 'utf-8' }).trim();
    } catch {
      // Fall back to authenticated user if not in a repo
      owner = execSync('gh api user -q .login', { stdio: 'pipe', encoding: 'utf-8' }).trim();
    }

    // List repositories for the owner (org or user)
    const output = execSync(`gh repo list "${owner}" --json name,createdAt,url,visibility --limit 1000`, {
      stdio: 'pipe',
      encoding: 'utf-8'
    });
    const repos = JSON.parse(output) as any[];

    // Filter resources
    let matches = repos;

    if (filterPattern) {
      // Use custom filter pattern
      const pattern = filterPattern.toLowerCase();
      matches = matches.filter((repo: any) => {
        const name = (repo?.name || '').toLowerCase();
        return name.includes(pattern);
      });
    } else if (projectName) {
      // Filter by project name (GitHub repos don't have -dev/-prod suffix typically)
      const pattern = projectName.toLowerCase();
      matches = matches.filter((repo: any) => {
        const name = (repo?.name || '').toLowerCase();
        return name === pattern || name.startsWith(`${pattern}-`);
      });
    }
    // If neither filterPattern nor projectName: return all resources

    return matches.map((repo: any) => ({
      id: `${owner}/${repo.name}`,
      name: repo.name,
      environment: 'unknown' as const,
      metadata: {
        url: repo.url,
        visibility: repo.visibility
      },
      createdAt: repo.createdAt
    }));
  } catch (error: any) {
    if (verbose) {
      console.warn(`  Warning: Failed to list GitHub repositories: ${error?.message || error}`);
    }
    return [];
  }
}

/**
 * Delete a GitHub repository
 */
export async function deleteGitHubInstance(
  instanceId: string,
  options: { verbose?: boolean }
): Promise<{ id: string; name: string; success: boolean; error?: string }> {
  const { verbose } = options;

  try {
    // instanceId format: "username/repo-name"
    const repoName = instanceId.split('/')[1] || instanceId;

    // Delete repository with confirmation flag
    execSync(`gh repo delete "${instanceId}" --yes`, {
      stdio: verbose ? 'inherit' : 'pipe'
    });

    if (verbose) {
      console.log(`    Deleted GitHub repository ${instanceId}`);
    }

    return {
      id: instanceId,
      name: repoName,
      success: true
    };
  } catch (error: any) {
    const errorMsg = error?.message || String(error);

    // Check for missing delete_repo scope
    if (errorMsg.includes('delete_repo')) {
      return {
        id: instanceId,
        name: instanceId.split('/')[1] || instanceId,
        success: false,
        error: 'Missing delete_repo scope. Run: gh auth refresh -h github.com -s delete_repo'
      };
    }

    return {
      id: instanceId,
      name: instanceId.split('/')[1] || instanceId,
      success: false,
      error: errorMsg
    };
  }
}
