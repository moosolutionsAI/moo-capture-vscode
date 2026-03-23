const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');

/** Copy webview-ui/dist/ → dist/webview/ */
function copyWebviewDist() {
  const src = path.join(__dirname, 'webview-ui', 'dist');
  const dest = path.join(__dirname, 'dist', 'webview');

  if (!fs.existsSync(src)) {
    console.log('[esbuild] webview-ui/dist/ not found — skipping copy');
    return;
  }

  fs.mkdirSync(dest, { recursive: true });

  function copyDir(srcDir, destDir) {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  copyDir(src, dest);
  console.log('[esbuild] Copied webview-ui/dist/ → dist/webview/');
}

async function build() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    sourcemap: true,
    target: 'node18',
  });

  if (isWatch) {
    await ctx.watch();
    console.log('[esbuild] Watching for changes...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    copyWebviewDist();
    console.log('[esbuild] Build complete');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
