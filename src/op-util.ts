import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function ensureOpAuth() {
  try {
    execSync('op whoami', { stdio: 'ignore' });
    return;
  } catch (e) {}
  try {
    // Attempt interactive sign-in (biometric/UI) in this shell
    execSync('op signin', { stdio: 'inherit' });
  } catch (e) {
    // If user cancels, continue; subsequent op calls will fail with clear errors
  }
}

type OpItemField = { id: string; label?: string; value?: string; section?: { id: string } };
type OpItem = { id: string; title: string; fields?: OpItemField[]; sections?: OpItemSection[] };
type OpItemSection = { id: string; label: string };

/**
 * Section and field definitions for creating/updating items
 */
export interface ItemSection {
  label: string;
  fields: ItemField[];
}

export interface ItemField {
  label: string;
  value: string;
  type?: 'STRING' | 'EMAIL' | 'URL' | 'CONCEALED' | 'PASSWORD';
}

export function opGetItem(vault: string, item: string): OpItem | null {
  try {
    const out = execSync(`op item get --vault ${JSON.stringify(vault)} ${JSON.stringify(item)} --format json`, { stdio: 'pipe' }).toString();
    return JSON.parse(out) as OpItem;
  } catch (e) {
    return null;
  }
}

export function opItemField(item: OpItem | null, fieldName: string): string | null {
  if (!item?.fields) return null;
  const f = item.fields.find((x) => (x.label || '').toLowerCase() === fieldName.toLowerCase());
  return (f?.value as string) || null;
}

export function opReadRef(ref: string): string | null {
  try {
    const out = execSync(`op read ${JSON.stringify(ref)}`, { stdio: 'pipe' }).toString().trim();
    return out || null;
  } catch (e) {
    return null;
  }
}

export function opEnsureVault(name: string, verbose?: boolean): { existed: boolean } {
  if (!name) return { existed: false };
  try {
    execSync(`op vault get ${JSON.stringify(name)}`, { stdio: 'ignore' });
    if (verbose) {
      console.log(`  Vault "${name}" already exists, using existing vault`);
    }
    return { existed: true };
  } catch (e) {
    // Vault doesn't exist, create it
    try {
      execSync(`op vault create ${JSON.stringify(name)}`, { stdio: verbose ? 'inherit' : 'ignore' });
      if (verbose) {
        console.log(`  Created new vault: ${name}`);
      }
      return { existed: false };
    } catch (createError: any) {
      throw new Error(`Failed to create vault "${name}": ${createError?.message || createError}`);
    }
  }
}

/**
 * Create or update a 1Password item with sections and fields
 * @param vault Vault name
 * @param itemTitle Item title (e.g., "Neon", "CapRover")
 * @param category Item category (default: "SECURE_NOTE")
 * @param sections Array of sections with fields
 * @param verbose Enable verbose logging
 */
export function opEnsureItemWithSections(
  vault: string,
  itemTitle: string,
  sections: ItemSection[],
  category: string = 'SECURE_NOTE',
  verbose?: boolean
): void {
  // Check if item exists
  const existingItem = opGetItem(vault, itemTitle);

  if (existingItem) {
    // Item exists - update fields
    if (verbose) {
      console.log(`  Updating existing item: ${itemTitle}`);
    }

    // ENHANCEMENT: Check which sections exist
    const existingSections = new Set(
      (existingItem.sections || []).map((s: any) => s.label.toLowerCase())
    );

    // Check if any required sections are missing
    const missingSections = sections.filter(
      section => !existingSections.has(section.label.toLowerCase())
    );

    if (missingSections.length > 0) {
      // Some sections don't exist - recreate item to ensure proper structure
      if (verbose) {
        console.log(`  Section(s) missing: ${missingSections.map(s => s.label).join(', ')}`);
        console.log(`  Recreating item with complete structure...`);
      }

      // Delete existing item
      try {
        execSync(
          `op item delete --vault ${JSON.stringify(vault)} ${JSON.stringify(itemTitle)}`,
          { stdio: 'pipe' }
        );
        if (verbose) {
          console.log(`  Deleted existing item to recreate with new sections`);
        }
      } catch (e) {
        // Item may not exist or already deleted, that's okay
      }

      // Recursively call to create fresh item
      return opEnsureItemWithSections(vault, itemTitle, sections, category, verbose);
    }

    // All sections exist - update fields
    for (const section of sections) {
      for (const field of section.fields) {
        opSetField(vault, itemTitle, section.label, field.label, field.value, field.type, verbose);
      }
    }
  } else {
    // Item doesn't exist - create it with template
    if (verbose) {
      console.log(`  Creating new item: ${itemTitle}`);
    }

    // Build item template JSON
    const template: any = {
      title: itemTitle,
      category: category,
      sections: [],
      fields: []
    };

    // Add sections and fields
    for (const section of sections) {
      const sectionId = section.label.toLowerCase().replace(/[^a-z0-9]/g, '_');
      template.sections.push({
        id: sectionId,
        label: section.label
      });

      for (const field of section.fields) {
        const fieldType = field.type || (field.label.toLowerCase().includes('password') || field.label.toLowerCase().includes('secret') || field.label.toLowerCase().includes('token') || field.label.toLowerCase().includes('key')) ? 'CONCEALED' : 'STRING';

        template.fields.push({
          id: `${sectionId}_${field.label.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
          label: field.label,
          type: fieldType,
          value: field.value,
          section: { id: sectionId }
        });
      }
    }

    // Write template to temp file
    const tempFile = path.join(os.tmpdir(), `op-item-${Date.now()}.json`);
    fs.writeFileSync(tempFile, JSON.stringify(template, null, 2));

    try {
      // Create item from template
      execSync(
        `op item create --vault ${JSON.stringify(vault)} --template ${JSON.stringify(tempFile)}`,
        { stdio: verbose ? 'inherit' : 'ignore' }
      );
    } finally {
      // Clean up temp file
      try {
        fs.unlinkSync(tempFile);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Set a field value in a specific section of an item
 * @param vault Vault name
 * @param itemTitle Item title
 * @param sectionLabel Section label
 * @param fieldLabel Field label
 * @param value Field value
 * @param fieldType Field type
 * @param verbose Enable verbose logging
 */
export function opSetField(
  vault: string,
  itemTitle: string,
  sectionLabel: string,
  fieldLabel: string,
  value: string,
  fieldType: string = 'STRING',
  verbose?: boolean
): void {
  try {
    // Try to edit existing field
    // Use stderr: 'inherit' to show errors while keeping stdout quiet
    execSync(
      `op item edit --vault ${JSON.stringify(vault)} ${JSON.stringify(itemTitle)} "${sectionLabel}.${fieldLabel}=${value}"`,
      { stdio: ['inherit', 'pipe', 'inherit'] }  // stdin, stdout, stderr
    );
    if (verbose) {
      console.log(`    Updated ${sectionLabel}.${fieldLabel}`);
    }
  } catch (e) {
    // Field doesn't exist - try creating it
    try {
      const type = fieldType || 'STRING';

      if (verbose) {
        console.log(`    Field ${sectionLabel}.${fieldLabel} doesn't exist, creating...`);
      }

      execSync(
        `op item edit --vault ${JSON.stringify(vault)} ${JSON.stringify(itemTitle)} --section ${JSON.stringify(sectionLabel)} "${fieldLabel}[${type}]=${value}"`,
        { stdio: ['inherit', 'pipe', 'inherit'] }
      );

      if (verbose) {
        console.log(`    Created ${sectionLabel}.${fieldLabel}`);
      }
    } catch (createError: any) {
      // CRITICAL: Throw error instead of silent failure
      const errorMsg = createError.stderr?.toString() || createError.message || String(createError);
      throw new Error(
        `Failed to set field '${sectionLabel}.${fieldLabel}' in item '${itemTitle}': ${errorMsg}\n` +
        `This may indicate the section '${sectionLabel}' doesn't exist. ` +
        `Try re-running with --force to recreate the item.`
      );
    }
  }

  // CRITICAL: Verify the field was actually saved
  const savedValue = opReadField(vault, itemTitle, sectionLabel, fieldLabel);
  if (!savedValue) {
    throw new Error(
      `Field '${sectionLabel}.${fieldLabel}' was set but verification failed. ` +
      `The field may not have been saved correctly.`
    );
  }

  if (verbose) {
    console.log(`    ✓ Verified ${sectionLabel}.${fieldLabel} was saved`);
  }
}

/**
 * Read a field value from a specific section
 * @param vault Vault name
 * @param itemTitle Item title
 * @param sectionLabel Section label (empty string for default section)
 * @param fieldLabel Field label
 * @returns Field value or null if not found
 */
export function opReadField(
  vault: string,
  itemTitle: string,
  sectionLabel: string,
  fieldLabel: string
): string | null {
  try {
    // Build reference path - omit section if empty (for default section)
    const ref = sectionLabel
      ? `op://${vault}/${itemTitle}/${sectionLabel}/${fieldLabel}`
      : `op://${vault}/${itemTitle}/${fieldLabel}`;
    return opReadRef(ref);
  } catch (e) {
    return null;
  }
}
