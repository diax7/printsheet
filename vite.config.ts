import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Plugin } from 'vitest/config';
import { viteSingleFile } from 'vite-plugin-singlefile';
import pkg from './package.json' with { type: 'json' };

/**
 * The hosted page gets its Content-Security-Policy as a header (vercel.json). The same policy is
 * written into the built file as a meta tag, so a copy opened from disk is just as locked down.
 * frame-ancestors only works as a header, so it is left out of the meta tag. Build only: the dev
 * server loads scripts from files, which the policy would block.
 */
function contentSecurityPolicy(): Plugin {
  const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
    headers: Array<{ headers: Array<{ key: string; value: string }> }>;
  };
  const policy = vercel.headers
    .flatMap((rule) => rule.headers)
    .find((h) => h.key === 'Content-Security-Policy')?.value;
  if (!policy) throw new Error('vercel.json has no Content-Security-Policy header');
  const meta = policy
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d && !d.startsWith('frame-ancestors'))
    .join('; ');
  return {
    name: 'printsheet-csp',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: meta },
        injectTo: 'head-prepend',
      },
    ],
  };
}

export default defineConfig({
  plugins: [contentSecurityPolicy(), viteSingleFile()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  assetsInclude: ['**/*.icc'],
  // Classic (iife) workers: an ES-module worker failed to start from file:// in testing.
  worker: { format: 'iife' },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
});
