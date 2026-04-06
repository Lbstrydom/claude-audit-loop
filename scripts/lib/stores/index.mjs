/**
 * @fileoverview Adapter selection and loading.
 * pickAdapter() determines which adapter to use based on AUDIT_STORE env var.
 */

const VALID_ADAPTERS = ['noop', 'supabase'];
const _loggedOnce = new Set();

function logOnce(key, msg) {
  if (_loggedOnce.has(key)) return;
  _loggedOnce.add(key);
  process.stderr.write(`  [learning] ${msg}\n`);
}

/**
 * Pick the adapter based on env vars.
 * 1. Explicit AUDIT_STORE wins
 * 2. Backward-compat auto-detect for existing Supabase users
 * 3. Default to noop
 *
 * @returns {string} Adapter name
 */
export function pickAdapter() {
  const explicit = process.env.AUDIT_STORE;
  if (explicit) {
    return validateExplicitAdapter(explicit);
  }

  // Backward-compat auto-detect
  if (process.env.SUPABASE_AUDIT_URL && process.env.SUPABASE_AUDIT_ANON_KEY) {
    logOnce('auto-detect',
      'Legacy Supabase env detected; using supabase adapter. Set AUDIT_STORE=supabase to silence this notice.');
    return 'supabase';
  }

  return 'noop';
}

/**
 * Validate an explicit AUDIT_STORE value. Fail-fast on bad config.
 * @param {string} name
 * @returns {string}
 */
function validateExplicitAdapter(name) {
  const normalized = name.toLowerCase().trim();

  if (!VALID_ADAPTERS.includes(normalized)) {
    process.stderr.write(`  [learning] ERROR: AUDIT_STORE="${name}" is not a valid adapter.\n`);
    process.stderr.write(`  Valid values: ${VALID_ADAPTERS.join(', ')}\n`);
    process.exit(1);
  }

  // Validate required env vars per adapter
  if (normalized === 'supabase') {
    const missing = [];
    if (!process.env.SUPABASE_AUDIT_URL) missing.push('SUPABASE_AUDIT_URL');
    if (!process.env.SUPABASE_AUDIT_ANON_KEY) missing.push('SUPABASE_AUDIT_ANON_KEY');
    if (missing.length > 0) {
      process.stderr.write(`  [learning] ERROR: AUDIT_STORE=supabase requires: ${missing.join(', ')}\n`);
      process.stderr.write(`  Set these env vars or use AUDIT_STORE=noop\n`);
      process.exit(1);
    }
  }

  return normalized;
}

/**
 * Dynamically load an adapter module.
 * @param {string} name - Adapter name
 * @returns {Promise<import('./interfaces.mjs').StorageAdapter>}
 */
export async function loadAdapterModule(name) {
  switch (name) {
    case 'noop': {
      const mod = await import('./noop-store.mjs');
      return mod.adapter;
    }
    case 'supabase': {
      try {
        const mod = await import('./supabase-store.mjs');
        return mod.adapter;
      } catch (err) {
        if (err.code === 'ERR_MODULE_NOT_FOUND' || err.message?.includes('supabase')) {
          process.stderr.write(
            `  [learning] ERROR: AUDIT_STORE=supabase requires @supabase/supabase-js but it is not installed.\n` +
            `  Run: npm install @supabase/supabase-js\n` +
            `  (Or set AUDIT_STORE=noop to run without cloud persistence.)\n`
          );
          process.exit(1);
        }
        throw err;
      }
    }
    default:
      process.stderr.write(`  [learning] ERROR: Unknown adapter "${name}"\n`);
      process.exit(1);
  }
}

export { VALID_ADAPTERS };
