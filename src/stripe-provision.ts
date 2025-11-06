/**
 * Stripe provisioning (payment processing)
 * - Helps user save Stripe credentials to 1Password vault
 * - Stripe account must be created manually at stripe.com
 */

import { execSync } from 'node:child_process';
import { ensureOpAuth, opEnsureVault, opEnsureItemWithSections, ItemSection } from './op-util.js';
import { ProvisionOptions, StripeResult } from './types.js';
import { RollbackAction } from './rollback.js';
import { getStripeCredentials, getMissingCredentialsMessage } from './credentials.js';
import { promptText, promptSecret } from './prompt-util.js';

/**
 * Provision Stripe credentials (bring-your-own mode)
 * Stripe account must be created manually at https://dashboard.stripe.com/
 */
export async function provisionStripe(
  options: ProvisionOptions
): Promise<{ result: StripeResult; rollbackActions: RollbackAction[] }> {
  const { projectName, envSuffix, verbose, dryRun } = options;
  const rollbackActions: RollbackAction[] = [];

  const vaultName = `${projectName}-${envSuffix}`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-');

  if (verbose) {
    console.log(`  Stripe provisioning for vault: ${vaultName}`);
  }

  if (dryRun) {
    console.log(`  [DRY RUN] Would save Stripe credentials to 1Password vault: ${vaultName}`);
    return {
      result: {
        apiKey: 'sk_test_dry_run',
        webhookSecret: 'whsec_dry_run',
        customerPortalUrl: 'https://billing.stripe.com/dry-run',
        hobbyPlanId: 'price_dry_run_hobby',
        proPlanId: 'price_dry_run_pro'
      },
      rollbackActions
    };
  }

  // Try to get credentials from environment or credentials store
  let credentials = getStripeCredentials();

  // If not found, prompt user interactively
  if (!credentials.apiKey) {
    console.log('\n  Stripe API Key not found in environment.');
    console.log('  Please create a Stripe account at https://dashboard.stripe.com/');
    console.log('  Then get your API key from: https://dashboard.stripe.com/apikeys\n');

    const apiKey = await promptSecret('  Enter Stripe API Key (sk_test_... or sk_live_...)');
    credentials.apiKey = apiKey;
  }

  if (!credentials.webhookSecret) {
    console.log('\n  Stripe Webhook Secret not found.');
    console.log('  Create a webhook endpoint in Stripe Dashboard, then copy the signing secret.\n');

    const webhookSecret = await promptSecret('  Enter Stripe Webhook Secret (whsec_...)');
    credentials.webhookSecret = webhookSecret;
  }

  // Optional fields with defaults
  const customerPortalUrl = credentials.customerPortalUrl ||
    await promptText('  Enter Stripe Customer Portal URL (optional, press Enter to skip)');

  const hobbyPlanId = credentials.hobbyPlanId ||
    await promptText('  Enter Hobby Plan Price ID (optional, e.g., price_...)');

  const proPlanId = credentials.proPlanId ||
    await promptText('  Enter Pro Plan Price ID (optional, e.g., price_...)');

  try {
    // Write to 1Password project vault
    ensureOpAuth();
    opEnsureVault(vaultName);

    // Create Stripe item with sections
    const stripeSections: ItemSection[] = [
      {
        label: 'Credentials',
        fields: [
          { label: 'api_key', value: credentials.apiKey!, type: 'CONCEALED' },
          { label: 'webhook_secret', value: credentials.webhookSecret!, type: 'CONCEALED' }
        ]
      }
    ];

    // Add URLs section if customer portal URL is provided
    if (customerPortalUrl) {
      stripeSections.push({
        label: 'URLs',
        fields: [
          { label: 'customer_portal_url', value: customerPortalUrl, type: 'URL' }
        ]
      });
    }

    // Add Plans section if any plan ID is provided
    const planFields: Array<{ label: string; value: string; type: 'STRING' }> = [];
    if (hobbyPlanId) {
      planFields.push({ label: 'hobby_subscription_plan_id', value: hobbyPlanId, type: 'STRING' });
    }
    if (proPlanId) {
      planFields.push({ label: 'pro_subscription_plan_id', value: proPlanId, type: 'STRING' });
    }
    if (planFields.length > 0) {
      stripeSections.push({
        label: 'Plans',
        fields: planFields
      });
    }

    opEnsureItemWithSections(vaultName, 'Stripe', stripeSections, undefined, verbose);

    if (verbose) {
      console.log(`  ✓ Wrote Stripe credentials to 1Password vault: ${vaultName}`);
    } else {
      console.log(`  ✓ Stripe: credentials saved`);
    }

    return {
      result: {
        apiKey: credentials.apiKey!,
        webhookSecret: credentials.webhookSecret!,
        customerPortalUrl: customerPortalUrl || undefined,
        hobbyPlanId: hobbyPlanId || undefined,
        proPlanId: proPlanId || undefined
      },
      rollbackActions
    };
  } catch (e: any) {
    throw new Error(`Stripe provisioning failed: ${e?.message || e}`);
  }
}

/**
 * List Stripe instances (not applicable - Stripe is bring-your-own)
 */
export async function listStripeInstances(
  options: { projectName?: string; envSuffix?: 'dev' | 'prod'; filterPattern?: string; verbose?: boolean }
): Promise<Array<{ id: string; name: string; environment?: 'dev' | 'prod' | 'unknown'; metadata?: any }>> {
  // Stripe doesn't have "instances" to list - it's a bring-your-own credentials service
  return [];
}

/**
 * Delete Stripe instance (not applicable - Stripe is bring-your-own)
 */
export async function deleteStripeInstance(
  instanceId: string,
  options: { verbose?: boolean }
): Promise<{ id: string; name: string; success: boolean; error?: string }> {
  return {
    id: instanceId,
    name: 'Stripe',
    success: false,
    error: 'Stripe credentials are managed manually and should be removed from 1Password vault directly'
  };
}
