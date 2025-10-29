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
