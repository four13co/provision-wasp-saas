/**
 * Update workflow files in existing Wasp projects
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface UpdateWorkflowsOptions {
  verbose?: boolean;
  dryRun?: boolean;
  force?: boolean;
}

interface UpdateResult {
  success: boolean;
  filesUpdated: string[];
  filesCreated: string[];
  filesBackedUp: string[];
  errors: string[];
}

export async function updateWorkflows(options: UpdateWorkflowsOptions = {}): Promise<UpdateResult> {
  const { verbose = false, dryRun = false, force = false } = options;

  const result: UpdateResult = {
    success: true,
    filesUpdated: [],
    filesCreated: [],
    filesBackedUp: [],
    errors: []
  };

  try {
    // Find git root
    let gitRoot = process.cwd();
    if (!fs.existsSync(path.join(gitRoot, '.git'))) {
      const parentDir = path.dirname(gitRoot);
      if (fs.existsSync(path.join(parentDir, '.git'))) {
        gitRoot = parentDir;
      } else {
        throw new Error('Not in a git repository. Please run this command from your Wasp project root.');
      }
    }

    if (verbose) {
      console.log(`  Git root: ${gitRoot}`);
    }

    // Check if this looks like a Wasp project
    const waspFiles = ['main.wasp', '.wasproot', 'app/main.wasp'];
    const hasWaspFile = waspFiles.some(f => fs.existsSync(path.join(gitRoot, f)));

    if (!hasWaspFile) {
      console.warn('  ⚠️  Warning: No Wasp project detected (no main.wasp found)');
      console.warn('  Continuing anyway, but make sure you\'re in the right directory.');
    }

    const workflowsDir = path.join(gitRoot, '.github', 'workflows');
    const templatesDir = path.join(gitRoot, 'templates');

    // Create directories if they don't exist
    if (!dryRun) {
      if (!fs.existsSync(workflowsDir)) {
        fs.mkdirSync(workflowsDir, { recursive: true });
      }
      if (!fs.existsSync(templatesDir)) {
        fs.mkdirSync(templatesDir, { recursive: true });
      }
    }

    // Backup existing workflows (unless --force)
    if (!force && !dryRun) {
      const backupDir = path.join(gitRoot, '.github', 'workflows.backup');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
      const backupDirWithTimestamp = `${backupDir}-${timestamp}`;

      if (fs.existsSync(workflowsDir)) {
        fs.mkdirSync(backupDirWithTimestamp, { recursive: true });
        const existingFiles = fs.readdirSync(workflowsDir).filter(f => f.endsWith('.yml'));

        for (const file of existingFiles) {
          const srcPath = path.join(workflowsDir, file);
          const destPath = path.join(backupDirWithTimestamp, file);
          fs.copyFileSync(srcPath, destPath);
          result.filesBackedUp.push(file);

          if (verbose) {
            console.log(`  ✓ Backed up: ${file} → workflows.backup-${timestamp}/`);
          }
        }

        if (existingFiles.length > 0 && !verbose) {
          console.log(`  ✓ Backed up ${existingFiles.length} workflow files to .github/workflows.backup-${timestamp}/`);
        }
      }
    }

    // Get template files
    const templateWorkflowsDir = path.join(__dirname, '../templates/workflows');
    const templateDockerfilePath = path.join(__dirname, '../templates/Dockerfile');

    // Workflow files to copy
    const workflowFiles = [
      'deploy-api-reusable.yml',
      'deploy-ui-reusable.yml',
      'deploy-dev.yml',
      'deploy-prod.yml'
    ];

    // Copy workflow files
    for (const file of workflowFiles) {
      const srcPath = path.join(templateWorkflowsDir, file);
      const destPath = path.join(workflowsDir, file);

      if (!fs.existsSync(srcPath)) {
        result.errors.push(`Template file not found: ${file}`);
        continue;
      }

      const content = fs.readFileSync(srcPath, 'utf-8');

      // Try to detect project name from git remote or directory
      let projectName = '{{PROJECT_NAME}}';
      try {
        const { execSync } = await import('node:child_process');
        const remoteUrl = execSync('git remote get-url origin', { cwd: gitRoot, encoding: 'utf-8' }).trim();
        const match = remoteUrl.match(/[:/]([^/]+)\.git$/);
        if (match) {
          projectName = match[1];
        }
      } catch {
        // Fall back to directory name
        projectName = path.basename(gitRoot);
      }

      // Replace placeholder
      const updatedContent = content.replace(/\{\{PROJECT_NAME\}\}/g, projectName);

      if (dryRun) {
        console.log(`  [DRY RUN] Would update: ${file}`);
        if (verbose && projectName !== '{{PROJECT_NAME}}') {
          console.log(`    → Replacing {{PROJECT_NAME}} with: ${projectName}`);
        }
      } else {
        fs.writeFileSync(destPath, updatedContent);
        const existed = result.filesBackedUp.includes(file);
        if (existed) {
          result.filesUpdated.push(file);
        } else {
          result.filesCreated.push(file);
        }

        if (verbose) {
          console.log(`  ✓ ${existed ? 'Updated' : 'Created'}: ${file}`);
        }
      }
    }

    // Copy Dockerfile template
    const dockerfileDest = path.join(templatesDir, 'Dockerfile');
    if (fs.existsSync(templateDockerfilePath)) {
      const dockerfileContent = fs.readFileSync(templateDockerfilePath, 'utf-8');

      if (dryRun) {
        console.log(`  [DRY RUN] Would update: templates/Dockerfile`);
      } else {
        const dockerfileExisted = fs.existsSync(dockerfileDest);
        fs.writeFileSync(dockerfileDest, dockerfileContent);

        if (dockerfileExisted) {
          result.filesUpdated.push('templates/Dockerfile');
        } else {
          result.filesCreated.push('templates/Dockerfile');
        }

        if (verbose) {
          console.log(`  ✓ ${dockerfileExisted ? 'Updated' : 'Created'}: templates/Dockerfile`);
        }
      }
    }

    // Remove old deploy-reusable.yml if it exists
    const oldWorkflow = path.join(workflowsDir, 'deploy-reusable.yml');
    if (fs.existsSync(oldWorkflow)) {
      if (dryRun) {
        console.log(`  [DRY RUN] Would remove: deploy-reusable.yml (deprecated)`);
      } else {
        fs.unlinkSync(oldWorkflow);
        result.filesUpdated.push('deploy-reusable.yml (removed)');
        if (verbose) {
          console.log(`  ✓ Removed deprecated: deploy-reusable.yml`);
        }
      }
    }

    // Remove old captain-definition if it exists
    const oldCaptainDef = path.join(gitRoot, 'captain-definition');
    if (fs.existsSync(oldCaptainDef)) {
      if (dryRun) {
        console.log(`  [DRY RUN] Would remove: captain-definition (deprecated)`);
      } else {
        fs.unlinkSync(oldCaptainDef);
        result.filesUpdated.push('captain-definition (removed)');
        if (verbose) {
          console.log(`  ✓ Removed deprecated: captain-definition`);
        }
      }
    }

    // Summary
    if (!dryRun && !verbose) {
      if (result.filesCreated.length > 0) {
        console.log(`  ✓ Created ${result.filesCreated.length} new files`);
      }
      if (result.filesUpdated.length > 0) {
        console.log(`  ✓ Updated ${result.filesUpdated.length} existing files`);
      }
    }

    if (!dryRun) {
      console.log('\n✅ Workflows updated successfully!');
      console.log('\nNext steps:');
      console.log('  1. Review changes: git diff .github/workflows/');
      console.log('  2. Test deployment: git push origin Development');
      console.log('  3. Monitor GitHub Actions for parallel API/UI deployments');
      console.log('\nSee UPDATING.md for troubleshooting and rollback instructions.');
    }

  } catch (error: any) {
    result.success = false;
    result.errors.push(error.message || String(error));
    console.error(`\n❌ Update failed: ${error.message || error}`);
  }

  return result;
}
