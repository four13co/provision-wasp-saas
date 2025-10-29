import { execSync } from 'node:child_process';

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

type OpItemField = { id: string; label?: string; value?: string };
type OpItem = { id: string; title: string; fields?: OpItemField[] };

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

export function opEnsureVault(name: string): void {
  if (!name) return;
  try {
    execSync(`op vault get ${JSON.stringify(name)}`, { stdio: 'ignore' });
    return;
  } catch (e) {
    // attempt create
    execSync(`op vault create ${JSON.stringify(name)}`, { stdio: 'ignore' });
  }
}
