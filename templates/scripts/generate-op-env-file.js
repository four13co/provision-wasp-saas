#!/usr/bin/env node

/**
 * Generate .1password.env file with op:// references
 * This file can be used with `op run --env-file=.1password.env` to load secrets
 *
 * This script reads the 1Password reference structure from env-emit.ts
 * and generates a file that matches the workflow's expectations
 */

const fs = require('fs');
const path = require('path');

/**
 * Map of environment variable names to their 1Password paths
 * This should match the getOpReferencePath function in env-emit.ts
 */
function getOpReferencePath(vaultPlaceholder, envVar) {
  const pathMap = {
    // Auth
    'JWT_SECRET': `op://${vaultPlaceholder}/Auth/Secrets/jwt_secret`,

    // Neon Database
    'DATABASE_URL': `op://${vaultPlaceholder}/Neon/Database/database_url`,
    'NEON_PROJECT_ID': `op://${vaultPlaceholder}/Neon/Database/project_id`,
    'POSTGRES_HOST': `op://${vaultPlaceholder}/Neon/Connection/postgres_host`,

    // CapRover
    'CAPROVER_APP_NAME': `op://${vaultPlaceholder}/CapRover/Application/app_name`,
    'CAPROVER_APP_TOKEN': `op://${vaultPlaceholder}/CapRover/Deployment/app_token`,
    'CAPROVER_URL': `op://${vaultPlaceholder}/CapRover/Server/url`,
    'API_URL': `op://${vaultPlaceholder}/CapRover/URLs/api_url`,

    // Vercel
    'VERCEL_PROJECT_ID': `op://${vaultPlaceholder}/Vercel/Project/project_id`,
    'VERCEL_PROJECT_NAME': `op://${vaultPlaceholder}/Vercel/Project/project_name`,
    'VERCEL_ORG_ID': `op://${vaultPlaceholder}/Vercel/Organization/org_id`,
    'VERCEL_TOKEN': `op://${vaultPlaceholder}/Vercel/Credentials/token`,
    'APP_URL': `op://${vaultPlaceholder}/Vercel/URLs/app_url`,

    // Netlify
    'NETLIFY_SITE_ID': `op://${vaultPlaceholder}/Netlify/Site/site_id`,
    'NETLIFY_SITE_NAME': `op://${vaultPlaceholder}/Netlify/Site/site_name`,
    'NETLIFY_TOKEN': `op://${vaultPlaceholder}/Netlify/Credentials/token`,

    // Resend
    'RESEND_API_KEY': `op://${vaultPlaceholder}/Resend/Credentials/api_key`,
    'RESEND_API_KEY_ID': `op://${vaultPlaceholder}/Resend/Credentials/api_key_id`,
    'EMAIL_FROM': `op://${vaultPlaceholder}/Resend/Configuration/email_from`,

    // Stripe
    'STRIPE_API_KEY': `op://${vaultPlaceholder}/Stripe/Credentials/api_key`,
    'STRIPE_WEBHOOK_SECRET': `op://${vaultPlaceholder}/Stripe/Credentials/webhook_secret`,
    'STRIPE_CUSTOMER_PORTAL_URL': `op://${vaultPlaceholder}/Stripe/URLs/customer_portal_url`,
    'PAYMENTS_HOBBY_SUBSCRIPTION_PLAN_ID': `op://${vaultPlaceholder}/Stripe/Plans/hobby_subscription_plan_id`,
    'PAYMENTS_PRO_SUBSCRIPTION_PLAN_ID': `op://${vaultPlaceholder}/Stripe/Plans/pro_subscription_plan_id`,

    // SendGrid
    'SENDGRID_API_KEY': `op://${vaultPlaceholder}/Sendgrid/Credentials/api_key`,

    // AWS S3
    'AWS_S3_IAM_ACCESS_KEY': `op://${vaultPlaceholder}/AWS/Credentials/access_key`,
    'AWS_S3_IAM_SECRET_KEY': `op://${vaultPlaceholder}/AWS/Credentials/secret_key`,
    'AWS_S3_FILES_BUCKET': `op://${vaultPlaceholder}/AWS/Configuration/files_bucket`,

    // Google OAuth
    'GOOGLE_CLIENT_ID': `op://${vaultPlaceholder}/Google/OAuth/client_id`,
    'GOOGLE_CLIENT_SECRET': `op://${vaultPlaceholder}/Google/OAuth/client_secret`,

    // Admin
    'ADMIN_EMAILS': `op://${vaultPlaceholder}/Admin/Configuration/emails`,
  };

  return pathMap[envVar] || null;
}

function generateOpEnvFile(vaultPlaceholder = '{{VAULT}}') {
  console.log('📝 Generating .1password.env file template...\n');

  const envLines = [
    '# 1Password environment reference file',
    '# Use with: op run --env-file=.1password.env -- <command>',
    '# Replace {{VAULT}} with your actual vault name',
    ''
  ];

  // Get all environment variables
  const allVars = Object.keys(getOpReferencePath.toString().match(/\'([A-Z_]+)\':/g) || [])
    .map(s => s.replace(/[':]/g, ''));

  // Better approach: explicitly list all vars
  const envVars = [
    'DATABASE_URL',
    'JWT_SECRET',
    'STRIPE_API_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_CUSTOMER_PORTAL_URL',
    'PAYMENTS_HOBBY_SUBSCRIPTION_PLAN_ID',
    'PAYMENTS_PRO_SUBSCRIPTION_PLAN_ID',
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
    'VERCEL_ORG_ID',
    'API_URL',
    'APP_URL',
    'ADMIN_EMAILS'
  ];

  for (const varName of envVars) {
    const ref = getOpReferencePath(vaultPlaceholder, varName);
    if (ref) {
      envLines.push(`${varName}=${ref}`);
    }
  }

  const content = envLines.join('\n') + '\n';
  fs.writeFileSync('.1password.env', content, 'utf8');

  console.log(`✅ Generated .1password.env template with ${envVars.length} references`);
  console.log('   Replace {{VAULT}} with your actual vault name before using.\n');
}

// Allow specifying vault name as argument
const vaultName = process.argv[2] || '{{VAULT}}';
generateOpEnvFile(vaultName);
