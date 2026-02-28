#!/bin/sh
set -e

# Auto-install missing npm plugins defined in openclaw.json before starting.
# This solves the chicken-and-egg problem where openclaw CLI refuses to run
# (even `plugins install`) when the config references a plugin that isn't
# on disk yet — e.g. after a fresh data-volume or new environment setup.
#
# Replicates what `openclaw plugins install <spec>` does:
#   1. npm pack to download the tarball
#   2. Extract package contents to the install path
#   3. npm install to fetch dependencies
#
# Also compiles TypeScript plugins to JS to avoid jiti native module resolution
# issues (e.g. sqlite3 bindings not found when loaded via jiti).

CONFIG="$HOME/.openclaw/openclaw.json"
if [ -f "$CONFIG" ]; then
  node -e "
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const cfg = JSON.parse(fs.readFileSync(process.env.HOME + '/.openclaw/openclaw.json', 'utf8'));

for (const [id, info] of Object.entries(cfg.plugins?.installs || {})) {
  if (info.source === 'npm' && info.installPath) {
    // Check for the plugin's own package.json with a 'name' field (not a wrapper)
    const pkgPath = path.join(info.installPath, 'package.json');
    let needsInstall = true;
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.name) needsInstall = false;
      } catch {}
    }

    if (needsInstall) {
      console.log('[entrypoint] Installing missing plugin:', info.spec, '->', info.installPath);

      // Download tarball via npm pack
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-plugin-'));
      const packOutput = execSync('npm pack ' + info.spec + ' --pack-destination ' + tmpDir, {
        cwd: tmpDir, encoding: 'utf8'
      }).trim();
      const tgzPath = path.join(tmpDir, packOutput.split('\n').pop().trim());

      // Extract to install path (npm pack tarballs have a 'package/' prefix)
      fs.mkdirSync(info.installPath, { recursive: true });
      execSync('tar xzf ' + tgzPath + ' --strip-components=1 -C ' + info.installPath, { stdio: 'inherit' });

      // Install dependencies
      execSync('npm install --no-fund --no-audit --production', { cwd: info.installPath, stdio: 'inherit' });

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true });
      console.log('[entrypoint] Plugin installed:', id);
    }

    // Compile TypeScript plugins to JS to avoid jiti native module resolution issues.
    // jiti incorrectly resolves __dirname for native addons (e.g. sqlite3), causing
    // 'Could not locate the bindings file' errors at runtime. Pre-compiling to JS
    // bypasses jiti entirely for the plugin, so native modules resolve correctly.
    const pluginPkgPath = path.join(info.installPath, 'package.json');
    if (fs.existsSync(pluginPkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pluginPkgPath, 'utf8'));
        const extensions = pkg.openclaw?.extensions || [];
        const hasTs = extensions.some(e => e.endsWith('.ts'));
        if (hasTs) {
          const tsconfigPath = path.join(info.installPath, 'tsconfig.build.json');
          const tscBin = path.join(info.installPath, 'node_modules/.bin/tsc');
          const indexTs = path.join(info.installPath, 'index.ts');
          const indexJs = path.join(info.installPath, 'index.js');
          const indexTsSrc = path.join(info.installPath, 'index.ts.src');
          if (fs.existsSync(tscBin) && fs.existsSync(tsconfigPath) && fs.existsSync(indexTs) && !fs.existsSync(indexJs)) {
            console.log('[entrypoint] Compiling TypeScript plugin to JS:', id);
            try {
              execSync(tscBin + ' -p ' + tsconfigPath + ' --noEmitOnError false 2>&1 || true', { cwd: info.installPath, shell: true });
              if (fs.existsSync(indexJs)) {
                fs.renameSync(indexTs, indexTsSrc);
                pkg.openclaw.extensions = extensions.map(e => e.replace(/\.ts$/, '.js'));
                fs.writeFileSync(pluginPkgPath, JSON.stringify(pkg, null, 2));
                console.log('[entrypoint] Plugin compiled successfully:', id);
              } else {
                console.error('[entrypoint] Compile produced no output for:', id);
              }
            } catch(e) {
              console.error('[entrypoint] Failed to compile plugin:', id, e.message);
            }
          }
        }
      } catch {}
    }
  }
}
"
fi

exec "$@"
