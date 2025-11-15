# Implementation Guide: 1Password Runtime Secret Loading for Wasp Apps

## Context

This document provides complete instructions for updating the `provision-wasp-saas` CLI tool to generate Wasp applications that load secrets from 1Password at server startup, rather than at build time via GitHub Actions.

## Background: What Changed

### Old Pattern (Current)
- GitHub Actions loads secrets from 1Password using `1password/load-secrets-action@v2`
- Secrets written to `.env.server` file during build
- `.env.server` file baked into Docker image or deployed with code
- CapRover receives secrets via environment variables or .env files

**Problems:**
- Secrets visible in GitHub Actions logs
- Secrets stored in multiple places (1Password + CapRover + potentially in images)
- Hard to rotate secrets (need to redeploy)
- Security risk if .env files leak

### New Pattern (Target)
- Only 2 secrets in CapRover: `OP_SERVICE_ACCOUNT_TOKEN` and `OP_VAULT`
- Server loads all other secrets from 1Password at startup using `@1password/sdk`
- Secrets loaded via Wasp's `setupFn` hook before server accepts requests
- No .env files, no secrets in images, no secrets in GitHub Actions

**Benefits:**
- Single source of truth (1Password)
- No secrets in CI/CD logs or intermediate files
- Easy secret rotation (restart container, no rebuild)
- Fail-safe (server won't start if secrets missing)

## Reference Implementation

The clickup-overwatch project (`/Users/gregflint/git/clickup-overwatch`) has the complete working implementation:

### Key Files to Reference

1. **`/Users/gregflint/git/clickup-overwatch/app/src/server/serverSetup.ts`**
   - Complete 1Password SDK integration
   - Loads secrets at server startup
   - Sets `process.env` variables
   - Proper error handling

2. **`/Users/gregflint/git/clickup-overwatch/app/main.wasp`** (lines 8-10)
   ```wasp
   server: {
     setupFn: import { initializeSecretsFromOnePassword } from "@src/server/serverSetup"
   },
   ```

3. **`/Users/gregflint/git/clickup-overwatch/app/package.json`** (line 5)
   ```json
   "@1password/sdk": "^0.1.0",
   ```

4. **`/Users/gregflint/git/clickup-overwatch/.github/workflows/deploy-reusable.yml`**
   - Simplified 1Password loading (only 2 secrets)
   - No .env file generation steps

## Implementation Tasks

### Task 1: Add Server Setup Template

**Create new file:** `templates/src/server/serverSetup.ts`

**Content:** Copy the exact file from clickup-overwatch:
```bash
cp /Users/gregflint/git/clickup-overwatch/app/src/server/serverSetup.ts \
   /Users/gregflint/git/provision-wasp-saas/templates/src/server/serverSetup.ts
```

**Important Notes:**
- This file is language-agnostic and works for any Wasp app
- The 1Password vault structure is standardized across all apps
- The secret references follow the pattern: `op://{vault}/ItemName/Section/field`

### Task 2: Update Deployment Workflow Template

**File to modify:** `templates/workflows/deploy-reusable.yml`

**Current section to replace (around lines 35-60):**
```yaml
- name: Load secrets from 1Password
  uses: 1password/load-secrets-action@v2
  with:
    export-env: true
  env:
    OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}
    DATABASE_URL: op://${{ secrets.OP_VAULT }}/Neon/Database/database_url
    JWT_SECRET: op://${{ secrets.OP_VAULT }}/Auth/Secrets/jwt_secret
    # ... many more secrets ...
```

**Replace with:**
```yaml
- name: Load 1Password service account token
  uses: 1password/load-secrets-action@v2
  with:
    export-env: true
  env:
    OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}
    # Only load the service account token - all other secrets loaded at runtime
```

**Remove these steps entirely:**
- `Build .env.server` step
- `Build .env.client` step
- `Validate required environment variables` step

**Rationale:**
- GitHub Actions only needs OP_SERVICE_ACCOUNT_TOKEN to pass to CapRover
- All other secrets loaded by the running container via serverSetup.ts
- No .env files generated during build

### Task 3: Update Package.json Template

**File to check:** Look for where package.json is generated or templated

**Possible locations:**
- `templates/package.json` (if it exists as a template file)
- Code in `src/` that generates package.json programmatically

**Action:** Add this dependency:
```json
{
  "dependencies": {
    "@1password/sdk": "^0.1.0",
    // ... other dependencies
  }
}
```

**How to find it:**
```bash
# Search for package.json generation
grep -r "package.json" src/
# Or check for template
ls -la templates/package.json
```

### Task 4: Update Main.wasp Generation

**File to find:** Code that generates or templates `main.wasp`

**Search for it:**
```bash
grep -r "main.wasp" src/
grep -r "app.*{" templates/
```

**What to add:** In the app block, add server configuration:
```wasp
app YourAppName {
  wasp: {
    version: "^0.18.0"
  },

  title: "Your App",

  server: {
    setupFn: import { initializeSecretsFromOnePassword } from "@src/server/serverSetup"
  },

  // ... rest of app config
}
```

**Important:** This must be added to the app configuration block, after `title` and before other configurations like `auth`.

### Task 5: Update CapRover Environment Variable Setup

**File to modify:** Documentation or provisioning code that sets up CapRover

**Current approach:** The tool likely has code or docs that tell users to set environment variables in CapRover for each secret.

**New approach:** Only 2 environment variables needed in CapRover:

```bash
# Via CapRover Web UI:
# 1. Go to CapRover → Your App → App Configs → Environmental Variables
# 2. Add only these two:

OP_SERVICE_ACCOUNT_TOKEN=op://your-vault/ClickUp Overwatch/credential
OP_VAULT=Production

# OR via CapRover API (if automated):
curl -X POST https://captain.your-domain.com/api/v2/user/apps/appDefinitions/update \
  -H "x-captain-auth: $CAPROVER_APP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "appName": "your-app-name",
    "envVars": [
      {"key": "OP_SERVICE_ACCOUNT_TOKEN", "value": "your-token-here"},
      {"key": "OP_VAULT", "value": "Production"}
    ]
  }'
```

**Files to check:**
- README templates
- Setup documentation
- Any provisioning scripts that configure CapRover

### Task 6: Remove or Update Old Scripts

**Files to handle:**

1. **`templates/scripts/generate-env-server.js`**
   - **Action:** DELETE (no longer needed)
   - **Rationale:** Secrets loaded at runtime, not build time

2. **`templates/scripts/generate-env-client.js`**
   - **Action:** KEEP (client still needs env vars at build time)
   - **Note:** Client env vars are public (API URLs, etc.), not secrets

3. **`templates/scripts/validate-env.js`**
   - **Action:** DELETE or UPDATE
   - **Rationale:** Server validates at startup via serverSetup.ts
   - **Alternative:** Could keep for local development validation

### Task 7: Update Documentation Templates

**Files to update:**
- `templates/README.md` (if exists)
- Any setup or deployment documentation

**Key documentation changes:**

#### Development Setup
```markdown
## Running Locally

The server loads secrets from 1Password at startup. You need:

1. 1Password CLI installed
2. Service account token set

### Option 1: Using 1Password CLI (Recommended)
```bash
# Set environment variables
export OP_SERVICE_ACCOUNT_TOKEN=your-token
export OP_VAULT=Production

# Start Wasp
wasp start
```

### Option 2: Using .env.server
```bash
# Create .env.server with only:
OP_SERVICE_ACCOUNT_TOKEN=your-token
OP_VAULT=Production

# Start Wasp
wasp start
```

The server will automatically load all other secrets from 1Password on startup.
```

#### Production Deployment
```markdown
## CapRover Setup

Set only 2 environment variables in CapRover:

1. Go to CapRover dashboard
2. Navigate to your app
3. App Configs → Environmental Variables
4. Add:
   - `OP_SERVICE_ACCOUNT_TOKEN` = Your 1Password service account token
   - `OP_VAULT` = `Production` (or `Development`)

All other secrets (DATABASE_URL, API keys, etc.) will be loaded from 1Password when the container starts.

**Security Note:** Never set actual secrets as environment variables in CapRover. Only the 1Password service account token should be there.
```

## 1Password Vault Structure

The generated apps expect this exact structure in 1Password:

```
Production/ (or Development/)
├── Neon/
│   └── Database/
│       └── database_url
├── Auth/
│   └── Secrets/
│       └── jwt_secret
├── Vercel/
│   └── URLs/
│       └── app_url
├── CapRover/
│   └── URLs/
│       └── api_url
├── Stripe/
│   └── Credentials/
│       ├── api_key
│       └── webhook_secret
├── Sendgrid/
│   └── Credentials/
│       └── api_key
├── Resend/
│   └── Credentials/
│       └── api_key
├── AWS/
│   ├── Credentials/
│   │   ├── access_key
│   │   └── secret_key
│   └── Configuration/
│       └── files_bucket
├── Google/
│   └── OAuth/
│       ├── client_id
│       └── client_secret
└── Admin/
    ├── emails
    └── allowed_emails
```

**In 1Password UI:**
- Each top-level name (Neon, Auth, etc.) is an **Item**
- Each second-level name (Database, Secrets, etc.) is a **Section** within that item
- Each third-level name (database_url, jwt_secret, etc.) is a **Field** in that section

## Testing the Changes

### Test 1: Generate a New App
```bash
cd /Users/gregflint/git/provision-wasp-saas
npm run build
npx provision-wasp-saas --project test-app --provision
```

**Verify:**
- [ ] `test-app/src/server/serverSetup.ts` exists
- [ ] `test-app/main.wasp` contains `server: { setupFn: ... }`
- [ ] `test-app/package.json` contains `@1password/sdk`
- [ ] `.github/workflows/deploy-reusable.yml` only loads OP_SERVICE_ACCOUNT_TOKEN
- [ ] No `generate-env-server.js` script (or it's updated)

### Test 2: Build and Run Test App
```bash
cd test-app
export OP_SERVICE_ACCOUNT_TOKEN=your-token
export OP_VAULT=Production
wasp start
```

**Expected output:**
```
🔐 Initializing secrets from 1Password...
📦 Loading secrets from 1Password vault: Production
  ✅ Loaded DATABASE_URL
  ✅ Loaded JWT_SECRET
  ✅ Loaded WASP_WEB_CLIENT_URL
  ... (all secrets)
📊 1Password secret loading complete:
   ✅ Successfully loaded: 15
   ❌ Failed to load: 0
✅ All secrets loaded successfully from 1Password!

🚀 Server listening on port 3001
```

### Test 3: Deploy to CapRover
1. Configure CapRover with only 2 env vars
2. Deploy using GitHub Actions
3. Check CapRover logs for successful secret loading
4. Verify app starts and functions correctly

## Migration Strategy for Existing Apps

If provision-wasp-saas has already generated apps using the old pattern:

### For New Apps
- Generate with new pattern automatically

### For Existing Apps
Users need to:
1. Update their `main.wasp` (add setupFn)
2. Add `@1password/sdk` to package.json
3. Add `src/server/serverSetup.ts`
4. Update `.github/workflows/deploy-reusable.yml`
5. Remove old scripts
6. Update CapRover environment variables

**Provide migration guide:** Create a separate `MIGRATION.md` in provision-wasp-saas that users can follow.

## Common Issues and Solutions

### Issue 1: "@1password/sdk not found"
**Cause:** Package not installed or not in dependencies
**Solution:** Run `npm install` and verify package.json

### Issue 2: "OP_SERVICE_ACCOUNT_TOKEN not set"
**Cause:** Environment variable not configured in CapRover
**Solution:** Add to CapRover App Configs → Environmental Variables

### Issue 3: "Failed to load DATABASE_URL"
**Cause:** 1Password vault structure doesn't match expected format
**Solution:** Verify vault structure matches the documented format above

### Issue 4: Server starts but crashes immediately
**Cause:** setupFn threw an error (missing secrets)
**Solution:** Check container logs for which secret failed to load

## File Checklist

Files that MUST be modified:
- [ ] `templates/src/server/serverSetup.ts` (NEW)
- [ ] `templates/workflows/deploy-reusable.yml` (MODIFY)
- [ ] Package.json template or generation logic (MODIFY)
- [ ] main.wasp generation logic (MODIFY)
- [ ] Documentation templates (MODIFY)
- [ ] `templates/scripts/generate-env-server.js` (DELETE or UPDATE)
- [ ] `templates/scripts/validate-env.js` (DELETE or UPDATE)

Optional improvements:
- [ ] Add migration guide for existing apps
- [ ] Add troubleshooting documentation
- [ ] Update CLI help text
- [ ] Add validation for 1Password vault structure

## Success Criteria

The implementation is complete when:
1. ✅ Generated apps have serverSetup.ts file
2. ✅ Generated main.wasp includes setupFn configuration
3. ✅ Generated package.json includes @1password/sdk
4. ✅ Generated workflows only load OP_SERVICE_ACCOUNT_TOKEN
5. ✅ No .env generation scripts in templates
6. ✅ Documentation updated with new pattern
7. ✅ Test app successfully loads secrets and starts
8. ✅ Test app deploys to CapRover successfully

## Reference Commands

### Copy reference implementation files
```bash
# Copy serverSetup.ts template
cp /Users/gregflint/git/clickup-overwatch/app/src/server/serverSetup.ts \
   /Users/gregflint/git/provision-wasp-saas/templates/src/server/serverSetup.ts

# Compare workflow files
diff /Users/gregflint/git/clickup-overwatch/.github/workflows/deploy-reusable.yml \
     /Users/gregflint/git/provision-wasp-saas/templates/workflows/deploy-reusable.yml
```

### Test generation
```bash
cd /Users/gregflint/git/provision-wasp-saas
npm run build
npx provision-wasp-saas --project test-1password-app --provision
```

### Verify generated files
```bash
cd test-1password-app
grep -n "setupFn" main.wasp
grep -n "@1password/sdk" package.json
ls -la src/server/serverSetup.ts
```

## Questions to Clarify (If Needed)

Before starting, you may need to determine:
1. Does provision-wasp-saas use file templates or programmatic generation?
2. Where is package.json generated/templated?
3. Where is main.wasp generated/templated?
4. Should old apps get a migration guide or automatic migration?
5. Should the CLI validate 1Password vault structure?

## Additional Context

### Why This Matters
- More secure (single source of truth)
- Easier secret management (rotate in 1Password, restart container)
- Cleaner deploys (no secrets in logs/intermediate files)
- Better DevOps practices (infrastructure as code, secrets external)

### Alignment with Best Practices
- Follows 12-factor app methodology (config in environment)
- Aligns with zero-trust security model
- Reduces attack surface (fewer places secrets stored)
- Improves auditability (all secret access via 1Password)

---

## Final Notes

This is a significant improvement to how generated Wasp apps handle secrets. Take your time to implement it correctly. The reference implementation in clickup-overwatch is fully working and production-tested.

If you encounter any issues or need clarification on any step, document it and ask for guidance rather than making assumptions.

Good luck! 🚀
