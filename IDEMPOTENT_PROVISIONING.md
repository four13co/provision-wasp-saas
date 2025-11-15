# Idempotent Provisioning

This tool is designed to be **idempotent** - you can safely run it multiple times without creating duplicate infrastructure or causing conflicts.

## What is Idempotency?

Idempotent provisioning means:
- ✅ Running the same command multiple times produces the same result
- ✅ Existing infrastructure is detected and reused
- ✅ No duplicate resources are created
- ✅ Safe to re-run after partial failures

## Provider Duplicate Detection

Every infrastructure provider checks for existing resources before creating new ones:

### 1Password (Vaults)
```typescript
// src/op-util.ts:217
const vaults = execSync('op vault list --format=json');
const existingVault = vaults.find(v => v.name === vaultName);
```
- ✅ Checks if vault exists by name
- ✅ Reuses existing vault if found
- ✅ Only creates new vault if not found

### Neon (Database)
```typescript
// src/neon-provision.ts:115
const projects = await neon.listProjects();
const existing = projects.projects.find(p => p.name === projectName);
```
- ✅ Checks if project exists by name
- ✅ Reuses existing project and primary branch
- ✅ Only creates new project if not found

### Vercel (Frontend)
```typescript
// src/vercel-provision.ts:104
const projects = await vercelClient.listProjects();
const existingProject = projects.find(p => p.name === projectName);
```
- ✅ Checks if project exists by name
- ✅ Reuses existing project settings
- ✅ Only creates new project if not found

### CapRover (Backend)
```typescript
// src/caprover-provision.ts:86-113
const defsRes = await fetch(`${base}/user/apps/appDefinitions/`);
const existingApp = existingApps.find(a => a.appName === appName);
```
- ✅ Checks if app exists by name
- ✅ Reuses existing app configuration
- ✅ Only creates new app if not found
- ✅ Updates environment variables if service account created

### GitHub
```typescript
// src/service-account.ts:181-244
const validation = await validateGitHubSecrets(repo, environment, vaultName);
```
- ✅ Checks if secrets already exist
- ✅ Validates existing secrets are for correct vault
- ✅ Skips creation if valid secrets exist
- ✅ Only creates new secrets if missing or invalid

## Service Account Lifecycle

Service accounts are handled carefully to avoid duplication:

### CapRover Service Account
Created during CapRover provisioning:
```typescript
// src/caprover-provision.ts:288-356
const existingServiceAccountName = opReadField(
  vaultName,
  'CapRover',
  'ServiceAccount',
  'service_account_name'
);

if (!existingServiceAccountName) {
  // Create new service account
  // Set CapRover env vars
  // Store metadata in 1Password
}
```
- ✅ Checks 1Password vault for existing service account name
- ✅ Reuses existing service account if found
- ✅ Only creates new service account if not found
- ✅ Stores service account metadata in vault for future checks

### GitHub Actions Service Account
Created during GitHub provisioning:
```typescript
// src/service-account.ts:284-303
const validation = await validateGitHubSecrets(repo, environment, vaultName);

if (validation.exists && validation.valid) {
  // Skip - secrets already configured
}
```
- ✅ Checks GitHub for existing secrets
- ✅ Validates secrets are for correct vault
- ✅ Creates separate service account for GitHub Actions
- ✅ Independent from CapRover service account

**Important:** CapRover and GitHub Actions use DIFFERENT service accounts:
- `{project}-sa-{env}-caprover-v{timestamp}` for CapRover
- `{project}-sa-{env}-github-v{timestamp}` for GitHub Actions

This separation ensures:
- Each system has its own credentials
- Revoking one doesn't affect the other
- Audit trails are clear and separated

## Force Mode

Use the `--force` flag to reprovision even when resources exist:

```bash
provision-wasp-saas --force
```

### What Force Does
- **Service Accounts**: Creates NEW service accounts with new tokens
- **GitHub Secrets**: Overwrites existing secrets with new values
- **1Password Vaults**: Still reuses existing (never duplicates)
- **Neon Projects**: Still reuses existing (never duplicates)
- **Vercel Projects**: Still reuses existing (never duplicates)
- **CapRover Apps**: Still reuses existing (never duplicates)

### When to Use Force
- ✅ Service account token compromised
- ✅ GitHub secrets contain wrong values
- ✅ Need to rotate credentials for security
- ✅ Want to generate a fresh service account token

### When NOT to Use Force
- ❌ First time provisioning (not needed)
- ❌ Adding new environment (dev/prod - not needed)
- ❌ Just checking if resources exist (use normal mode)

## Safe Re-run Examples

### First Run (Creates Everything)
```bash
provision-wasp-saas --provision-caprover --env prod

# Creates:
# - Production vault in 1Password
# - Neon project and database
# - Vercel project
# - CapRover app
# - Service account for CapRover
# - Sets OP_SERVICE_ACCOUNT_TOKEN and OP_VAULT in CapRover
```

### Second Run (Reuses Everything)
```bash
provision-wasp-saas --provision-caprover --env prod

# Output:
# ✓ 1Password vault already exists: Production
# ✓ Neon project already exists: my-app-prod
# ✓ Vercel project already exists: my-app-prod
# ✓ CapRover app already exists: my-app-api-prod
# ✓ Service account already exists (metadata in vault)
```

### Adding GitHub Later
```bash
provision-wasp-saas --include-github --env prod

# Reuses:
# - Production vault (already exists)
# - Neon, Vercel, CapRover (already configured)
# Creates:
# - NEW service account for GitHub Actions
# - GitHub secrets (OP_SERVICE_ACCOUNT_TOKEN_PROD, OP_VAULT_PROD)
```

### Rotating Service Account
```bash
provision-wasp-saas --force --include-github --env prod

# Reuses infrastructure, creates new credentials:
# ✓ Using existing vault: Production
# ✓ Using existing Neon project: my-app-prod
# 🔄 Creating NEW GitHub service account (token rotation)
# 🔄 Updating GitHub secrets with new token
```

### Adding Second Environment
```bash
# After running prod, add dev
provision-wasp-saas --provision-caprover --env dev

# Creates:
# - Development vault (new)
# - my-app-dev Neon project (new)
# - my-app-dev Vercel project (new)
# - my-app-api-dev CapRover app (new)
# - Service account for Development (new)
```

## Failure Recovery

The tool is safe to re-run after failures:

### Scenario 1: Network Failure During Provisioning
```bash
provision-wasp-saas --provision-caprover --env prod
# ERROR: Network timeout while creating Vercel project

# Just re-run - it will:
# ✓ Reuse 1Password vault (already created)
# ✓ Reuse Neon project (already created)
# 🔄 Retry Vercel creation (failed step)
# ✓ Continue with CapRover...
```

### Scenario 2: Invalid Credentials
```bash
provision-wasp-saas --provision-caprover --env prod
# ERROR: Invalid CapRover password

# Fix the credential, then re-run - it will:
# ✓ Reuse everything already created
# 🔄 Retry CapRover with correct password
```

### Scenario 3: Service Account Creation Failed
```bash
provision-wasp-saas --provision-caprover --env prod
# CapRover app created successfully
# ERROR: Failed to create service account

# Just re-run - it will:
# ✓ Reuse CapRover app (already exists)
# 🔄 Retry service account creation
# 🔄 Set environment variables
```

## Environment Variable Updates

CapRover environment variables are set automatically:

### First Time
```bash
provision-wasp-saas --provision-caprover --env prod

# Sets in CapRover:
# OP_SERVICE_ACCOUNT_TOKEN=ops_xxx...
# OP_VAULT=Production
```

### Re-running (Existing Service Account)
```bash
provision-wasp-saas --provision-caprover --env prod

# Skips:
# ✓ Service account already exists (metadata in vault)
# ✓ Environment variables already set
```

### With Force (New Service Account)
```bash
provision-wasp-saas --provision-caprover --force --env prod

# Updates CapRover:
# 🔄 Creates new service account
# 🔄 Updates OP_SERVICE_ACCOUNT_TOKEN with new value
# ✓ OP_VAULT unchanged (Production)
```

## Checking What Exists

To see what's already provisioned:

### Check 1Password
```bash
op vault list
op item list --vault Production
```

### Check Neon
```bash
# Via Neon Dashboard
# Or: curl with NEON_API_KEY
```

### Check Vercel
```bash
vercel projects ls
```

### Check CapRover
```bash
# Via CapRover Dashboard: https://captain.yourdomain.com
# Or: Check apps list in API
```

### Check GitHub Secrets
```bash
gh secret list --repo owner/repo
```

## Best Practices

### ✅ DO
- Run provisioning multiple times to verify idempotency
- Use `--force` only when rotating credentials
- Keep service accounts separate (CapRover vs GitHub)
- Let the tool detect and reuse existing resources
- Re-run after failures (it's safe!)

### ❌ DON'T
- Manually create duplicate resources
- Use `--force` on first run (unnecessary)
- Delete service account metadata from 1Password
- Share service account tokens between environments
- Mix up dev and prod environments

## Troubleshooting

### "Service account already exists" message but app not working
```bash
# The service account metadata is in 1Password, but the token might be invalid
# Solution: Use --force to create a new service account
provision-wasp-saas --force --provision-caprover --env prod
```

### "GitHub secrets exist" but workflow fails
```bash
# The secrets might be for the wrong vault or expired
# Solution: Use --force to reprovision
provision-wasp-saas --force --include-github --env prod
```

### Want to completely start over
```bash
# 1. Delete resources manually:
op vault delete Production
# (delete Neon project via dashboard)
# (delete Vercel project: vercel projects rm)
# (delete CapRover app via dashboard)
gh secret delete OP_SERVICE_ACCOUNT_TOKEN_PROD --repo owner/repo
gh secret delete OP_VAULT_PROD --repo owner/repo

# 2. Re-run provisioning:
provision-wasp-saas --provision-caprover --include-github --env prod
```

### Service account token compromised
```bash
# If you suspect a service account token has been compromised
# Solution: Use --force to create new service account
provision-wasp-saas --force --env prod

# This will:
# - Create new service account with fresh credentials
# - Update GitHub secrets (if --include-github)
# - Update CapRover env vars (if --provision-caprover)
```

## Technical Implementation

See also:
- `RUNTIME_SECRET_LOADING.md` - How runtime secrets work
- `IMPLEMENT_1PASSWORD_RUNTIME_LOADING.md` - Implementation guide
- Source code comments in:
  - `src/caprover-provision.ts` - CapRover duplicate detection
  - `src/service-account.ts` - Service account lifecycle
  - `src/neon-provision.ts` - Neon duplicate detection
  - `src/vercel-provision.ts` - Vercel duplicate detection
  - `src/github-provision.ts` - GitHub secret validation

---

**Last Updated:** 2025-01-08
**Version:** 1.0.0
