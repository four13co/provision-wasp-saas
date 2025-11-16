# Updating Existing Wasp Repos to Latest Workflows

This guide covers how to update existing Wasp/OpenSaaS projects that were provisioned with earlier versions of `provision-wasp-saas` to use the latest deployment workflows.

## What's New

### Version 0.2.0 - Parallel Deployments & GHCR Integration

**Key Changes:**
- ✅ **Parallel deployments** - API and UI now deploy simultaneously (faster builds)
- ✅ **Docker + GHCR** - Backend deployed as Docker images from GitHub Container Registry
- ✅ **No more captain-definition** - Simplified CapRover deployment
- ✅ **Automatic image cleanup** - Keeps last 5 images to save storage

**Performance Improvement:**
- Before: ~10-15 minutes sequential deployment
- After: ~5-8 minutes parallel deployment

## Automated Update (Recommended)

Run this command from your Wasp project root:

```bash
npx provision-wasp-saas --update-workflows
```

This will:
1. Backup your existing workflow files to `.github/workflows.backup/`
2. Copy the latest workflow templates
3. Copy the Dockerfile template to `templates/`
4. Preserve your project-specific customizations
5. Show a summary of changes

### Options

```bash
# Dry run (see what would change without making changes)
npx provision-wasp-saas --update-workflows --dry-run

# Verbose output
npx provision-wasp-saas --update-workflows --verbose

# Force overwrite without backup
npx provision-wasp-saas --update-workflows --force
```

## Manual Update

If you prefer to update manually or need fine-grained control:

### Step 1: Backup Existing Workflows

```bash
cd your-wasp-project
mkdir -p .github/workflows.backup
cp .github/workflows/*.yml .github/workflows.backup/
```

### Step 2: Download New Workflow Files

```bash
# Remove old workflow
rm .github/workflows/deploy-reusable.yml

# Download new workflows
curl -o .github/workflows/deploy-api-reusable.yml \
  https://raw.githubusercontent.com/YOUR_USERNAME/provision-wasp-saas/main/templates/workflows/deploy-api-reusable.yml

curl -o .github/workflows/deploy-ui-reusable.yml \
  https://raw.githubusercontent.com/YOUR_USERNAME/provision-wasp-saas/main/templates/workflows/deploy-ui-reusable.yml

curl -o .github/workflows/deploy-dev.yml \
  https://raw.githubusercontent.com/YOUR_USERNAME/provision-wasp-saas/main/templates/workflows/deploy-dev.yml

curl -o .github/workflows/deploy-prod.yml \
  https://raw.githubusercontent.com/YOUR_USERNAME/provision-wasp-saas/main/templates/workflows/deploy-prod.yml
```

### Step 3: Add Dockerfile Template

```bash
# Create templates directory if it doesn't exist
mkdir -p templates

# Download Dockerfile
curl -o templates/Dockerfile \
  https://raw.githubusercontent.com/YOUR_USERNAME/provision-wasp-saas/main/templates/Dockerfile
```

### Step 4: Replace Project Name Placeholder

All workflow files contain `{{PROJECT_NAME}}` placeholder that needs to be replaced:

```bash
# Replace in all workflow files
sed -i '' 's/{{PROJECT_NAME}}/your-actual-project-name/g' .github/workflows/*.yml
```

Replace `your-actual-project-name` with your project name (e.g., `my-saas-app`).

### Step 5: Remove Old Files (Optional)

```bash
# Remove captain-definition if it exists
rm -f captain-definition

# Remove old backup if update was successful
rm -rf .github/workflows.backup/
```

### Step 6: Update CapRover Apps (If Already Deployed)

The new workflows use Docker image deployment instead of tarball uploads. Existing CapRover apps need no configuration changes - they already have the required `GITHUB_PAT` and `GITHUB_USERNAME` environment variables set during provisioning.

However, you may want to verify:

```bash
# Check CapRover app has GHCR credentials
op item get CapRover --vault your-project-dev --fields label=ServiceAccount
```

If you don't see GitHub credentials, re-run provisioning to add them:

```bash
npx provision-wasp-saas --provision-caprover --env dev --force
```

### Step 7: Test the New Workflows

```bash
# Commit the changes
git add .github/workflows/*.yml templates/Dockerfile
git commit -m "chore: update to parallel deployment workflows with GHCR"

# Push to Development branch to trigger deployment
git push origin Development
```

Watch the GitHub Actions tab to see the parallel API and UI deployments in action.

## Troubleshooting

### Error: "Failed to authenticate with CapRover"

**Cause:** CapRover app token may have changed.

**Fix:**
```bash
# Get the correct token from 1Password
op read "op://your-project-dev/CapRover/Deployment/app_token"

# Update in 1Password if needed, then re-run provisioning
npx provision-wasp-saas --provision-caprover --env dev --force
```

### Error: "authentication required" from GHCR

**Cause:** Missing or invalid GitHub PAT for GHCR access.

**Fix:**
```bash
# Verify GitHub PAT in 1Password
op read "op://your-project-dev/GitHub/Credentials/pat"

# Re-run GitHub provisioning to refresh credentials
npx provision-wasp-saas --provision-github --env dev --force
```

### Error: "Dockerfile not found"

**Cause:** Dockerfile template not copied to project.

**Fix:**
```bash
# Copy Dockerfile from provision-wasp-saas templates
mkdir -p templates
cp /path/to/provision-wasp-saas/templates/Dockerfile templates/
```

### Workflows still using old deploy-reusable.yml

**Cause:** Old workflow files not updated.

**Fix:**
```bash
# Check which workflow files exist
ls -la .github/workflows/

# If deploy-reusable.yml still exists and is referenced, delete it
rm .github/workflows/deploy-reusable.yml

# Verify deploy-dev.yml and deploy-prod.yml reference the new workflows
grep "deploy-api-reusable\|deploy-ui-reusable" .github/workflows/deploy-*.yml
```

## Rollback

If you need to rollback to the old workflows:

```bash
# Restore from backup
cp .github/workflows.backup/*.yml .github/workflows/

# Remove new files
rm .github/workflows/deploy-api-reusable.yml
rm .github/workflows/deploy-ui-reusable.yml
rm templates/Dockerfile

# Commit and push
git add .github/workflows/
git commit -m "chore: rollback to sequential deployment workflows"
git push origin Development
```

## Verification Checklist

After updating, verify:

- [ ] `.github/workflows/deploy-api-reusable.yml` exists
- [ ] `.github/workflows/deploy-ui-reusable.yml` exists
- [ ] `.github/workflows/deploy-dev.yml` references both new workflows
- [ ] `.github/workflows/deploy-prod.yml` references both new workflows
- [ ] `templates/Dockerfile` exists
- [ ] `{{PROJECT_NAME}}` placeholder replaced in all workflow files
- [ ] Old `deploy-reusable.yml` removed
- [ ] Old `captain-definition` removed (if it existed)
- [ ] GitHub Actions runs successfully on push to Development

## Need Help?

- Check the [provision-wasp-saas documentation](https://github.com/gregflint/provision-wasp-saas)
- Report issues at: https://github.com/gregflint/provision-wasp-saas/issues
- Review successful workflow runs in GitHub Actions for examples

---

**Last Updated:** 2025-01-15
**Applies to:** provision-wasp-saas v0.2.0+
