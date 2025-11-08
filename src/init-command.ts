/**
 * Init command - sets up the master vault with infrastructure credentials
 */

import { ensureOpAuth, opEnsureVault, opEnsureItemWithSections, opGetItem, ItemSection } from './op-util.js';
import { setMasterVault, getMasterVault, getConfigPath } from './config.js';
import { promptText, promptSecret, promptConfirm } from './prompt-util.js';

export interface InitOptions {
  vaultName?: string;
  verbose?: boolean;
}

export async function initCommand(options: InitOptions = {}): Promise<void> {
  const { verbose } = options;

  console.log('\n🔧 Initialize provision-wasp-saas\n');
  console.log('This will set up a 1Password vault with your infrastructure credentials.\n');

  // Ensure 1Password is authenticated
  ensureOpAuth();

  // Prompt for vault name
  const existingVault = getMasterVault();
  const defaultVault = existingVault || 'provision-wasp-saas-master';

  const vaultName = options.vaultName || await promptText(
    'Master vault name',
    defaultVault
  );

  if (!vaultName) {
    console.error('❌ Vault name is required');
    process.exit(1);
  }

  console.log(`\n📦 Using vault: ${vaultName}`);

  // Create vault if it doesn't exist
  try {
    opEnsureVault(vaultName);
    console.log('✓ Vault ready');
  } catch (e: any) {
    console.error(`❌ Failed to create vault: ${e?.message || e}`);
    process.exit(1);
  }

  // Save vault name to config
  setMasterVault(vaultName);
  console.log(`✓ Saved to config: ${getConfigPath()}\n`);

  // Prompt for each infrastructure provider
  console.log('📝 Enter credentials for infrastructure providers\n');
  console.log('   Press Enter to skip optional providers\n');

  // Neon
  const setupNeon = await promptConfirm('Set up Neon (PostgreSQL)?', true);
  if (setupNeon) {
    await setupNeonCredentials(vaultName, verbose);
  }

  // Vercel
  const setupVercel = await promptConfirm('Set up Vercel (Frontend hosting)?', true);
  if (setupVercel) {
    await setupVercelCredentials(vaultName, verbose);
  }

  // Netlify
  const setupNetlify = await promptConfirm('Set up Netlify (Alternative frontend)?', false);
  if (setupNetlify) {
    await setupNetlifyCredentials(vaultName, verbose);
  }

  // CapRover
  const setupCapRover = await promptConfirm('Set up CapRover (Backend hosting)?', false);
  if (setupCapRover) {
    await setupCapRoverCredentials(vaultName, verbose);
  }

  // Resend
  const setupResend = await promptConfirm('Set up Resend (Email service)?', false);
  if (setupResend) {
    await setupResendCredentials(vaultName, verbose);
  }

  // GitHub
  const setupGitHub = await promptConfirm('Set up GitHub (Container Registry access)?', false);
  if (setupGitHub) {
    await setupGitHubCredentials(vaultName, verbose);
  }

  console.log('\n✅ Initialization complete!\n');
  console.log('You can now run provisioning commands without environment variables:\n');
  console.log('  provision-wasp-saas --provision-neon --env prod\n');
  console.log('To update credentials, run: provision-wasp-saas init\n');
}

async function setupNeonCredentials(vaultName: string, verbose?: boolean): Promise<void> {
  console.log('\n🐘 Neon PostgreSQL');
  console.log('   Get API key from: https://console.neon.tech/app/settings/api-keys\n');

  // Check if item already exists
  const existingItem = opGetItem(vaultName, 'Neon');
  if (existingItem) {
    const overwrite = await promptConfirm('I already have this entry, do you want to overwrite?', false);
    if (!overwrite) {
      console.log('   Skipped Neon (keeping existing credentials)');
      return;
    }
  }

  const apiKey = await promptSecret('Neon API Key (required)');
  if (!apiKey) {
    console.log('   Skipped Neon setup');
    return;
  }

  const orgId = await promptText('Neon Organization ID (optional, for team accounts)', '');
  const region = await promptText('Neon Region', 'aws-us-east-1');

  const sections: ItemSection[] = [
    {
      label: 'Credentials',
      fields: [
        { label: 'api_key', value: apiKey, type: 'CONCEALED' }
      ]
    }
  ];

  if (orgId) {
    sections[0].fields.push({ label: 'org_id', value: orgId, type: 'STRING' });
  }

  if (region) {
    sections.push({
      label: 'Configuration',
      fields: [{ label: 'region', value: region, type: 'STRING' }]
    });
  }

  opEnsureItemWithSections(vaultName, 'Neon', sections, 'SECURE_NOTE', verbose);
  console.log('   ✓ Saved Neon credentials');
}

async function setupVercelCredentials(vaultName: string, verbose?: boolean): Promise<void> {
  console.log('\n▲ Vercel');
  console.log('   Get token from: https://vercel.com/account/tokens\n');

  // Check if item already exists
  const existingItem = opGetItem(vaultName, 'Vercel');
  if (existingItem) {
    const overwrite = await promptConfirm('I already have this entry, do you want to overwrite?', false);
    if (!overwrite) {
      console.log('   Skipped Vercel (keeping existing credentials)');
      return;
    }
  }

  const token = await promptSecret('Vercel Token (required)');
  if (!token) {
    console.log('   Skipped Vercel setup');
    return;
  }

  const teamId = await promptText('Vercel Team ID (optional, for team accounts)', '');

  const sections: ItemSection[] = [
    {
      label: 'Credentials',
      fields: [
        { label: 'token', value: token, type: 'CONCEALED' }
      ]
    }
  ];

  if (teamId) {
    sections[0].fields.push({ label: 'team_id', value: teamId, type: 'STRING' });
  }

  opEnsureItemWithSections(vaultName, 'Vercel', sections, 'SECURE_NOTE', verbose);
  console.log('   ✓ Saved Vercel credentials');
}

async function setupNetlifyCredentials(vaultName: string, verbose?: boolean): Promise<void> {
  console.log('\n🦋 Netlify');
  console.log('   Get token from: https://app.netlify.com/user/applications\n');

  // Check if item already exists
  const existingItem = opGetItem(vaultName, 'Netlify');
  if (existingItem) {
    const overwrite = await promptConfirm('I already have this entry, do you want to overwrite?', false);
    if (!overwrite) {
      console.log('   Skipped Netlify (keeping existing credentials)');
      return;
    }
  }

  const token = await promptSecret('Netlify Token (required)');
  if (!token) {
    console.log('   Skipped Netlify setup');
    return;
  }

  const teamSlug = await promptText('Netlify Team Slug (optional)', '');
  const teamId = await promptText('Netlify Team ID (optional)', '');

  const sections: ItemSection[] = [
    {
      label: 'Credentials',
      fields: [
        { label: 'token', value: token, type: 'CONCEALED' }
      ]
    }
  ];

  if (teamSlug || teamId) {
    const teamFields = [];
    if (teamSlug) teamFields.push({ label: 'team_slug', value: teamSlug, type: 'STRING' as const });
    if (teamId) teamFields.push({ label: 'team_id', value: teamId, type: 'STRING' as const });

    sections.push({
      label: 'Team',
      fields: teamFields
    });
  }

  opEnsureItemWithSections(vaultName, 'Netlify', sections, 'SECURE_NOTE', verbose);
  console.log('   ✓ Saved Netlify credentials');
}

async function setupCapRoverCredentials(vaultName: string, verbose?: boolean): Promise<void> {
  console.log('\n⚓ CapRover');
  console.log('   Self-hosted backend hosting\n');

  // Check if item already exists
  const existingItem = opGetItem(vaultName, 'CapRover');
  if (existingItem) {
    const overwrite = await promptConfirm('I already have this entry, do you want to overwrite?', false);
    if (!overwrite) {
      console.log('   Skipped CapRover (keeping existing credentials)');
      return;
    }
  }

  const url = await promptText('CapRover URL (e.g., https://captain.example.com)', '');
  if (!url) {
    console.log('   Skipped CapRover setup');
    return;
  }

  const password = await promptSecret('CapRover Password');

  const sections: ItemSection[] = [
    {
      label: 'Server',
      fields: [
        { label: 'url', value: url, type: 'URL' },
        { label: 'password', value: password, type: 'CONCEALED' }
      ]
    }
  ];

  opEnsureItemWithSections(vaultName, 'CapRover', sections, 'SECURE_NOTE', verbose);
  console.log('   ✓ Saved CapRover credentials');
}

async function setupResendCredentials(vaultName: string, verbose?: boolean): Promise<void> {
  console.log('\n📧 Resend');
  console.log('   Get API key from: https://resend.com/api-keys\n');

  // Check if item already exists
  const existingItem = opGetItem(vaultName, 'Resend');
  if (existingItem) {
    const overwrite = await promptConfirm('I already have this entry, do you want to overwrite?', false);
    if (!overwrite) {
      console.log('   Skipped Resend (keeping existing credentials)');
      return;
    }
  }

  const apiKey = await promptSecret('Resend API Key (required)');
  if (!apiKey) {
    console.log('   Skipped Resend setup');
    return;
  }

  console.log('\n   SMTP Configuration (for Wasp email sending):');
  const smtpServer = await promptText('SMTP Server', 'smtp.resend.com');
  const smtpPort = await promptText('SMTP Port', '587');
  const smtpUsername = await promptText('SMTP Username', 'resend');

  const sections: ItemSection[] = [
    {
      label: 'Credentials',
      fields: [
        { label: 'api_key', value: apiKey, type: 'CONCEALED' }
      ]
    },
    {
      label: 'SMTP',
      fields: [
        { label: 'smtp_server', value: smtpServer, type: 'STRING' },
        { label: 'smtp_port', value: smtpPort, type: 'STRING' },
        { label: 'username', value: smtpUsername, type: 'STRING' }
      ]
    }
  ];

  opEnsureItemWithSections(vaultName, 'Resend', sections, 'SECURE_NOTE', verbose);
  console.log('   ✓ Saved Resend credentials');
}

async function setupGitHubCredentials(vaultName: string, verbose?: boolean): Promise<void> {
  console.log('\n🐙 GitHub');
  console.log('   Get PAT from: https://github.com/settings/tokens');
  console.log('   Required scopes: read:packages, write:packages, delete:packages\n');

  // Check if item already exists
  const existingItem = opGetItem(vaultName, 'GitHub');
  if (existingItem) {
    const overwrite = await promptConfirm('I already have this entry, do you want to overwrite?', false);
    if (!overwrite) {
      console.log('   Skipped GitHub (keeping existing credentials)');
      return;
    }
  }

  const pat = await promptSecret('GitHub Personal Access Token (required for GHCR)');
  if (!pat) {
    console.log('   Skipped GitHub setup');
    return;
  }

  const username = await promptText('GitHub Username', '');

  const sections: ItemSection[] = [
    {
      label: 'Credentials',
      fields: [
        { label: 'pat', value: pat, type: 'CONCEALED' }
      ]
    }
  ];

  if (username) {
    sections.push({
      label: 'Registry',
      fields: [{ label: 'username', value: username, type: 'STRING' }]
    });
  }

  opEnsureItemWithSections(vaultName, 'GitHub', sections, 'SECURE_NOTE', verbose);
  console.log('   ✓ Saved GitHub credentials');
}
