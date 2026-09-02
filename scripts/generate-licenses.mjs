/**
 * Generate open-source license data from all production dependencies.
 *
 * Usage:
 *   node scripts/generate-licenses.mjs
 *
 * Output: constants/legal/licenses.json
 *
 * This script resolves each dependency's real path via Node's module resolution,
 * which follows pnpm symlinks into the .pnpm store automatically.
 */
import { createRequire } from 'module';
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync as fs_statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const appDir = join(__dirname, '..');

const require = createRequire(import.meta.url);

// --- Read app package.json ---
const appPkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf-8'));
const deps = Object.keys(appPkg.dependencies || {});

if (deps.length === 0) {
  console.warn('[licenses] No dependencies found, writing empty array.');
  writeFileSync(
    join(appDir, 'constants/legal/licenses.json'),
    '[]\n',
    'utf-8',
  );
  process.exit(0);
}

// --- License file candidates (checked case-insensitively) ---
const LICENSE_FILES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'LICENSE-MIT',
  'LICENSE-APACHE',
  'LICENCE',
  'LICENCE.md',
  'LICENCE.txt',
  'COPYING',
  'COPYING.md',
  'NOTICE',
  'UNLICENSE',
];

/**
 * Normalize the license field from package.json.
 * Handles string, object, and array shapes.
 */
function normalizeLicense(raw) {
  if (!raw) return 'UNKNOWN';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    if (Array.isArray(raw)) {
      return raw
        .map((e) => (typeof e === 'string' ? e : e?.type || 'UNKNOWN'))
        .join(', ');
    }
    return raw.type || raw.name || 'UNKNOWN';
  }
  return 'UNKNOWN';
}

/**
 * Normalize repository field to a URL string.
 */
function normalizeRepo(raw) {
  if (!raw) return undefined;
  if (typeof raw === 'string') {
    // shorthand like "user/repo"
    if (raw.includes('://')) return raw;
    if (/^[\w-]+\/[\w.-]+$/.test(raw)) return `https://github.com/${raw}`;
    return raw;
  }
  if (typeof raw === 'object' && raw.url) return raw.url;
  return undefined;
}

/**
 * Try to find a license file in the package directory.
 * Returns the full text content or a fallback string.
 */
function findLicenseText(pkgDir) {
  const entries = readdirSync(pkgDir);
  for (const candidate of LICENSE_FILES) {
    const lower = candidate.toLowerCase();
    const match = entries.find(
      (f) => f.toLowerCase() === lower || f.toLowerCase() === lower + '.txt',
    );
    if (match) {
      try {
        return readFileSync(join(pkgDir, match), 'utf-8');
      } catch {
        // fall through
      }
    }
  }
  return 'License file not found.';
}

// --- Process each dependency ---
const results = [];
const skipped = [];

function resolvePkgPath(dep, appDir) {
  // Try standard module resolution first (follows pnpm symlinks)
  try {
    return dirname(
      require.resolve(`${dep}/package.json`, { paths: [appDir] }),
    );
  } catch {
    // Fallback: some packages restrict "./package.json" via "exports".
    // Walk up from node_modules/{dep} and follow the symlink manually.
  }

  // Try direct node_modules path
  const directPaths = [
    join(appDir, 'node_modules', dep),
    join(dirname(appDir), '..', 'node_modules', dep), // monorepo root
  ];

  for (const p of directPaths) {
    const pkgJson = join(p, 'package.json');
    if (existsSync(pkgJson)) {
      try {
        const stat = fs_statSync(p);
        // If symlink, resolve already follows it for readFileSync
        return p;
      } catch {
        // fall through
      }
    }
  }

  // Try pnpm .pnpm store — find by name@version pattern
  const pnpmDir = join(dirname(appDir), '..', 'node_modules', '.pnpm');
  if (existsSync(pnpmDir)) {
    // Read app deps to find the exact version
    const appPkg2 = JSON.parse(
      readFileSync(join(appDir, 'package.json'), 'utf-8'),
    );
    const versionRange = appPkg2.dependencies?.[dep];
    if (versionRange) {
      const cleanVersion = versionRange.replace(/[\^~]/, '');
      const entries = readdirSync(pnpmDir);
      const match = entries.find(
        (e) =>
          e.startsWith(`${dep}@`) &&
          (e === `${dep}@${cleanVersion}` ||
            e.includes(`@${cleanVersion}`)),
      );
      if (match) {
        const storePath = join(pnpmDir, match, 'node_modules', dep);
        if (existsSync(storePath)) return storePath;
      }
    }
  }

  return null;
}

for (const dep of deps) {
  try {
    const pkgDir = resolvePkgPath(dep, appDir);
    if (!pkgDir) {
      skipped.push({ name: dep, reason: 'Could not resolve package directory' });
      continue;
    }
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8'));

    results.push({
      name: pkg.name || dep,
      version: pkg.version || 'UNKNOWN',
      license: normalizeLicense(pkg.license ?? pkg.licenses),
      homepage: pkg.homepage || undefined,
      repository: normalizeRepo(pkg.repository),
      licenseText: findLicenseText(pkgDir),
    });
  } catch (err) {
    skipped.push({ name: dep, reason: err.message });
  }
}

// --- Sort alphabetically ---
results.sort((a, b) => a.name.localeCompare(b.name));

// --- Write output ---
const outPath = join(appDir, 'constants/legal/licenses.json');
writeFileSync(outPath, JSON.stringify(results, null, 2) + '\n', 'utf-8');

console.log(
  `[licenses] Generated ${results.length} license entries, skipped ${skipped.length} packages → ${outPath}`,
);
if (skipped.length > 0) {
  console.warn('[licenses] Skipped packages:');
  for (const s of skipped) {
    console.warn(`  - ${s.name}: ${s.reason}`);
  }
}
