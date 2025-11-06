#!/usr/bin/env node

/**
 * Validate that required environment variables are present before deployment
 * This prevents cryptic deployment failures due to missing configuration
 */

// Required server environment variables (critical for deployment)
const REQUIRED_SERVER_VARS = [
  'DATABASE_URL',
  'JWT_SECRET',
  'API_URL',
  'APP_URL'
];

// Optional but recommended server environment variables
const OPTIONAL_SERVER_VARS = [
  'STRIPE_API_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'SENDGRID_API_KEY',
  'RESEND_API_KEY',
  'AWS_S3_IAM_ACCESS_KEY',
  'AWS_S3_IAM_SECRET_KEY',
  'AWS_S3_FILES_BUCKET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'CAPROVER_URL',
  'CAPROVER_APP_TOKEN',
  'VERCEL_TOKEN',
  'VERCEL_PROJECT_ID',
  'VERCEL_ORG_ID'
];

function validateEnvironment() {
  console.log('🔍 Validating environment variables...\n');

  const missing = [];
  const present = [];
  const warnings = [];

  // Check required variables
  for (const varName of REQUIRED_SERVER_VARS) {
    const value = process.env[varName];
    if (!value || value.trim() === '') {
      missing.push(varName);
    } else {
      present.push(varName);
    }
  }

  // Check optional variables
  for (const varName of OPTIONAL_SERVER_VARS) {
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
