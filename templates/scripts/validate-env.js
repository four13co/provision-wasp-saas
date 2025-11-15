#!/usr/bin/env node

/**
 * Validate that required CI/CD environment variables are present before deployment
 * This prevents cryptic deployment failures due to missing configuration
 *
 * Note: Application runtime secrets (DATABASE_URL, JWT_SECRET, etc.) are loaded
 * at server startup via serverSetup.ts and don't need to be validated here.
 */

// Required CI/CD variables (critical for deployment)
const REQUIRED_CICD_VARS = [
  'CAPROVER_URL',
  'CAPROVER_APP_TOKEN',
  'VERCEL_TOKEN',
  'VERCEL_PROJECT_ID',
  'VERCEL_ORG_ID',
  'API_URL',
  'APP_URL',
  'DATABASE_URL' // Needed for migrations during deployment
];

// Optional CI/CD variables
const OPTIONAL_CICD_VARS = [
  'GITHUB_PAT',
  'GITHUB_USERNAME'
];

function validateEnvironment() {
  console.log('🔍 Validating CI/CD environment variables...\n');

  const missing = [];
  const present = [];
  const warnings = [];

  // Check required CI/CD variables
  for (const varName of REQUIRED_CICD_VARS) {
    const value = process.env[varName];
    if (!value || value.trim() === '') {
      missing.push(varName);
    } else {
      present.push(varName);
    }
  }

  // Check optional CI/CD variables
  for (const varName of OPTIONAL_CICD_VARS) {
    const value = process.env[varName];
    if (!value || value.trim() === '') {
      warnings.push(varName);
    } else {
      present.push(varName);
    }
  }

  // Report results
  if (present.length > 0) {
    console.log(`✅ Found ${present.length} environment variables:`);
    present.forEach(v => console.log(`   • ${v}`));
    console.log('');
  }

  if (warnings.length > 0) {
    console.log(`⚠️  Optional variables not set (${warnings.length}):`);
    warnings.forEach(v => console.log(`   • ${v}`));
    console.log('   (These are optional but may be needed for full functionality)\n');
  }

  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables (${missing.length}):`);
    missing.forEach(v => console.error(`   • ${v}`));
    console.error('\nDeployment cannot proceed without these critical variables.');
    console.error('Please ensure they are set in your 1Password vault.\n');
    process.exit(1);
  }

  console.log('✅ Environment validation passed!\n');
}

validateEnvironment();
