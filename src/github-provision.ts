/**
 * GitHub repository and CI/CD setup for Wasp projects
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface GitHubRepoOptions {
  projectName: string;
  verbose?: boolean;
}

export interface GitHubSecretsOptions {
  projectName: string;
  vaultDev: string;
  vaultProd: string;
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

  // Initialize git if not already initialized
  if (!fs.existsSync('.git')) {
    execSync('git init', { stdio: verbose ? 'inherit' : 'ignore' });
    execSync('git branch -M Development', { stdio: verbose ? 'inherit' : 'ignore' });
  }

  // Add remote
  try {
    execSync(`git remote add origin https://github.com/$(gh api user -q .login)/${projectName}.git`, {
      stdio: verbose ? 'inherit' : 'ignore'
    });
  } catch {
    // Remote might already exist
  }

  // Create Production branch reference
  execSync('git branch Production', { stdio: verbose ? 'inherit' : 'ignore' });

  if (verbose) console.log('  Initialized git with Development and Production branches');
}

export async function setupGitHubSecrets(options: GitHubSecretsOptions): Promise<void> {
  const { projectName, vaultDev, vaultProd, verbose } = options;

  // Get the script path relative to this module
  const scriptPath = path.join(__dirname, '../scripts/op-service-account.sh');

  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Service account script not found: ${scriptPath}`);
  }

  // Run the service account creation script
  const username = execSync('gh api user -q .login', { encoding: 'utf-8' }).trim();
  const repoFullName = `${username}/${projectName}`;

  execSync(
    `bash ${scriptPath} ${repoFullName} ${vaultDev} ${vaultProd}`,
    { stdio: verbose ? 'inherit' : 'ignore' }
  );

  if (verbose) {
    console.log('  Service account created');
    console.log('  GitHub secrets configured');
  }
}

export async function copyWorkflowTemplates(options: { projectName: string; verbose?: boolean }): Promise<void> {
  const { projectName, verbose } = options;

  // Create .github/workflows directory
  const workflowsDir = path.join(process.cwd(), '.github', 'workflows');
  fs.mkdirSync(workflowsDir, { recursive: true });

  // Get template directory
  const templatesDir = path.join(__dirname, '../templates/workflows');

  if (!fs.existsSync(templatesDir)) {
    throw new Error(`Workflow templates not found: ${templatesDir}`);
  }

  // Copy and customize workflow files
  const templates = fs.readdirSync(templatesDir).filter(f => f.endsWith('.yml'));

  for (const template of templates) {
    const templatePath = path.join(templatesDir, template);
    const targetPath = path.join(workflowsDir, template);

    let content = fs.readFileSync(templatePath, 'utf-8');

    // Replace placeholders
    content = content.replace(/\{\{PROJECT_NAME\}\}/g, projectName);

    fs.writeFileSync(targetPath, content);

    if (verbose) console.log(`  Copied ${template}`);
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
