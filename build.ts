/**
 * Build script for Claude Code CLI
 * Requires Bun: https://bun.sh
 * Run: bun run build.ts
 */
import type { BunPlugin } from 'bun'
import { existsSync, mkdirSync } from 'fs'
import { unlink } from 'fs/promises'
import * as path from 'path'

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------
const features: Record<string, boolean> = {
  ABLATION_BASELINE: false,
  AGENT_MEMORY_SNAPSHOT: false,
  AGENT_TRIGGERS: false,
  AGENT_TRIGGERS_REMOTE: false,
  ALLOW_TEST_VERSIONS: false,
  ANTI_DISTILLATION_CC: false,
  AUTO_THEME: true,
  AWAY_SUMMARY: false,
  BASH_CLASSIFIER: false,
  BG_SESSIONS: false,
  BREAK_CACHE_COMMAND: false,
  BRIDGE_MODE: false,
  BUDDY: false,
  BUILDING_CLAUDE_APPS: false,
  BUILTIN_EXPLORE_PLAN_AGENTS: true,
  BYOC_ENVIRONMENT_RUNNER: false,
  CACHED_MICROCOMPACT: false,
  CCR_AUTO_CONNECT: false,
  CCR_MIRROR: false,
  CCR_REMOTE_SETUP: false,
  CHICAGO_MCP: false,
  COMMIT_ATTRIBUTION: false,
  COMPACTION_REMINDERS: true,
  CONNECTOR_TEXT: false,
  CONTEXT_COLLAPSE: false,
  COORDINATOR_MODE: false,
  COWORKER_TYPE_TELEMETRY: false,
  DAEMON: false,
  DIRECT_CONNECT: false,
  DOWNLOAD_USER_SETTINGS: false,
  DUMP_SYSTEM_PROMPT: false,
  ENHANCED_TELEMETRY_BETA: false,
  EXPERIMENTAL_SKILL_SEARCH: false,
  EXTRACT_MEMORIES: true,
  FILE_PERSISTENCE: false,
  FORK_SUBAGENT: false,
  HARD_FAIL: false,
  HISTORY_PICKER: true,
  HISTORY_SNIP: false,
  HOOK_PROMPTS: false,
  IS_LIBC_GLIBC: false,
  IS_LIBC_MUSL: false,
  KAIROS: false,
  KAIROS_BRIEF: false,
  KAIROS_CHANNELS: false,
  KAIROS_DREAM: false,
  KAIROS_GITHUB_WEBHOOKS: false,
  KAIROS_PUSH_NOTIFICATION: false,
  LODESTONE: false,
  MCP_RICH_OUTPUT: true,
  MCP_SKILLS: false,
  MEMORY_SHAPE_TELEMETRY: false,
  MESSAGE_ACTIONS: true,
  MONITOR_TOOL: false,
  NATIVE_CLIENT_ATTESTATION: false,
  NATIVE_CLIPBOARD_IMAGE: false,
  NEW_INIT: true,
  OVERFLOW_TEST_TOOL: false,
  PERFETTO_TRACING: false,
  POWERSHELL_AUTO_MODE: false,
  PROMPT_CACHE_BREAK_DETECTION: false,
  QUICK_SEARCH: true,
  REACTIVE_COMPACT: false,
  REVIEW_ARTIFACT: false,
  RUN_SKILL_GENERATOR: false,
  SELF_HOSTED_RUNNER: false,
  SHOT_STATS: false,
  SKILL_IMPROVEMENT: false,
  SLOW_OPERATION_LOGGING: false,
  SSH_REMOTE: false,
  STREAMLINED_OUTPUT: true,
  TEAMMEM: false,
  TEMPLATES: false,
  TERMINAL_PANEL: false,
  TOKEN_BUDGET: true,
  TORCH: false,
  TRANSCRIPT_CLASSIFIER: false,
  TREE_SITTER_BASH: false,
  TREE_SITTER_BASH_SHADOW: false,
  UDS_INBOX: false,
  ULTRAPLAN: false,
  ULTRATHINK: true,
  UNATTENDED_RETRY: false,
  UPLOAD_USER_SETTINGS: false,
  VERIFICATION_AGENT: false,
  VOICE_MODE: false,
  WEB_BROWSER_TOOL: false,
  WORKFLOW_SCRIPTS: false,
}

// ---------------------------------------------------------------------------
// Pre-build: scan all source files, find missing imports, create stub files.
// This avoids using onResolve in a Bun plugin (which crashes Bun 1.3.11).
// ---------------------------------------------------------------------------
const srcRoot = path.resolve('./src')

function resolvedFileExists(base: string): boolean {
  if (existsSync(base)) return true
  for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx', '.js', '/index.js']) {
    if (existsSync(base + ext)) return true
  }
  // TypeScript ESM: import ends in .js/.jsx but real file is .ts/.tsx
  for (const jsExt of ['.js', '.jsx']) {
    if (base.endsWith(jsExt)) {
      const noExt = base.slice(0, -jsExt.length)
      if (existsSync(noExt + '.ts')) return true
      if (existsSync(noExt + '.tsx')) return true
      if (existsSync(noExt + '/index.ts')) return true
      if (existsSync(noExt + '/index.tsx')) return true
    }
  }
  return false
}

/** Determine stub file path from the resolved base path of the import */
function stubFilePath(base: string, imp: string): string {
  if (imp.endsWith('.d.ts')) return base
  if (imp.endsWith('.md'))   return base
  if (imp.endsWith('.js'))   return base.slice(0, -3)  + '.ts'
  if (imp.endsWith('.jsx'))  return base.slice(0, -4)  + '.tsx'
  if (imp.endsWith('.ts') || imp.endsWith('.tsx')) return base
  return base + '.ts'
}

/** Generate stub TypeScript source that exports all expected named bindings */
function makeStubSource(imp: string, namedExports: string[]): string {
  if (imp.endsWith('.d.ts')) return '// auto-stub\nexport {}\n'
  if (imp.endsWith('.md'))   return '# stub\n'
  const lines = [`// auto-stub: ${imp}`]
  for (const name of namedExports) {
    // Export each name as a no-op so named import checks pass
    lines.push(`export const ${name}: any = undefined`)
  }
  if (namedExports.length === 0) {
    lines.push('export default {}')
  }
  return lines.join('\n') + '\n'
}

/** Delete any auto-stub files left by a previous failed build */
async function cleanOldStubs(): Promise<void> {
  const glob = new Bun.Glob('**/*.{ts,tsx,d.ts,md}')
  const marker = '// auto-stub'
  for await (const rel of glob.scan(srcRoot)) {
    const filePath = path.join(srcRoot, rel)
    const content = await Bun.file(filePath).text().catch(() => '')
    if (content.startsWith(marker) || content.startsWith('# stub')) {
      await unlink(filePath).catch(() => {})
    }
  }
}

async function createMissingStubs(): Promise<string[]> {
  const created: string[] = []

  // stubFilePath → set of named exports that importers expect
  const neededExports = new Map<string, Set<string>>()
  // stubFilePath → original import string (for stub content)
  const stubImpMap = new Map<string, string>()

  // Regex patterns
  const namedImportPat = /import\s*(?:type\s*)?\{\s*([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g
  const allImportPats  = [
    /(?:from|import)\s+['"](\.[^'"]+)['"]/g,
    /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  ]

  const glob = new Bun.Glob('**/*.{ts,tsx}')
  for await (const rel of glob.scan(srcRoot)) {
    const filePath = path.join(srcRoot, rel)
    const fileDir  = path.dirname(filePath)
    const content  = await Bun.file(filePath).text()

    // --- Pass 1: collect named imports from missing modules ---
    namedImportPat.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = namedImportPat.exec(content)) !== null) {
      const names = m[1]
      const imp   = m[2]
      if (!imp) continue
      const base = path.resolve(fileDir, imp)
      if (resolvedFileExists(base)) continue

      const sp = stubFilePath(base, imp)
      if (!neededExports.has(sp)) neededExports.set(sp, new Set())
      stubImpMap.set(sp, imp)

      // Parse names: "foo, bar as _bar, type Baz" → ['foo', '_bar']
      for (const raw of names.split(',')) {
        const clean = raw.trim().replace(/^type\s+/, '')
        const alias = clean.split(/\s+as\s+/)
        const localName = (alias[1] ?? alias[0]).trim()
        if (localName) neededExports.get(sp)!.add(localName)
      }
    }

    // --- Pass 2: collect all missing import paths ---
    for (const pat of allImportPats) {
      pat.lastIndex = 0
      while ((m = pat.exec(content)) !== null) {
        const imp = m[1]
        if (!imp) continue
        const base = path.resolve(fileDir, imp)
        if (resolvedFileExists(base)) continue
        const sp = stubFilePath(base, imp)
        if (!neededExports.has(sp)) neededExports.set(sp, new Set())
        stubImpMap.set(sp, imp)
      }
    }
  }

  // --- Create stub files ---
  for (const [sp, names] of neededExports) {
    if (existsSync(sp)) continue
    const imp = stubImpMap.get(sp) ?? sp
    mkdirSync(path.dirname(sp), { recursive: true })
    await Bun.write(sp, makeStubSource(imp, [...names]))
    created.push(sp)
  }

  return created
}

// ---------------------------------------------------------------------------
// Plugin: feature flags + bun:bundle shim
// Only uses onLoad (no onResolve) to avoid Bun 1.3.11 crash.
// ---------------------------------------------------------------------------
function createFeatureFlagPlugin(featureMap: Record<string, boolean>): BunPlugin {
  return {
    name: 'feature-flags',
    setup(build) {
      build.onResolve({ filter: /^bun:bundle$/ }, () => ({
        path: 'bun-bundle-shim',
        namespace: 'virtual',
      }))

      build.onLoad({ filter: /.*/, namespace: 'virtual' }, () => ({
        contents: 'export function feature(_name) { return false }',
        loader: 'js',
      }))

      build.onLoad({ filter: /\.(ts|tsx)$/ }, async (args) => {
        let contents = await Bun.file(args.path).text()
        for (const [name, enabled] of Object.entries(featureMap)) {
          const val = String(enabled)
          contents = contents.replaceAll(`feature('${name}')`, val)
          contents = contents.replaceAll(`feature("${name}")`, val)
        }
        return { contents, loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts' }
      })

      // Markdown files → string export
      build.onLoad({ filter: /\.md$/ }, async (args) => ({
        contents: `export default ${JSON.stringify(await Bun.file(args.path).text())};`,
        loader: 'js',
      }))
    },
  }
}

// ---------------------------------------------------------------------------
// External packages
// ---------------------------------------------------------------------------
const externalPackages = [
  '@ant/claude-for-chrome-mcp',
  '@ant/computer-use-input',
  '@ant/computer-use-mcp',
  '@ant/computer-use-swift',
  '@anthropic-ai/mcpb',
  '@anthropic-ai/sandbox-runtime',
  'color-diff-napi',
  '@anthropic-ai/bedrock-sdk',
  '@anthropic-ai/foundry-sdk',
  '@anthropic-ai/vertex-sdk',
  '@azure/identity',
  '@opentelemetry/exporter-metrics-otlp-grpc',
  '@opentelemetry/exporter-metrics-otlp-http',
  '@opentelemetry/exporter-metrics-otlp-proto',
  '@opentelemetry/exporter-prometheus',
  '@opentelemetry/exporter-logs-otlp-grpc',
  '@opentelemetry/exporter-logs-otlp-http',
  '@opentelemetry/exporter-logs-otlp-proto',
  '@opentelemetry/exporter-trace-otlp-grpc',
  '@opentelemetry/exporter-trace-otlp-http',
  '@opentelemetry/exporter-trace-otlp-proto',
  'sharp',
  'modifiers-napi',
]

const macroDefines: Record<string, string> = {
  'MACRO.VERSION': JSON.stringify('1.0.0'),
  'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
  'MACRO.FEEDBACK_CHANNEL': JSON.stringify('https://github.com/anthropics/claude-code/issues'),
  'MACRO.ISSUES_EXPLAINER': JSON.stringify('Report issues at https://github.com/anthropics/claude-code/issues'),
  'MACRO.NATIVE_PACKAGE_URL': JSON.stringify(''),
  'MACRO.PACKAGE_URL': JSON.stringify('npm:@anthropic-ai/claude-code'),
  'MACRO.VERSION_CHANGELOG': JSON.stringify(''),
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log('Scanning for missing imports and creating stubs...')
await cleanOldStubs()
const stubs = await createMissingStubs()
if (stubs.length > 0) {
  console.log(`  Created ${stubs.length} stub file(s)`)
}

console.log('Building Claude Code...')
console.time('build')

const result = await Bun.build({
  entrypoints: ['./src/entrypoints/cli.tsx'],
  outdir: './dist',
  target: 'node',
  format: 'esm',
  define: macroDefines,
  external: externalPackages,
  naming: 'cli.js',
  plugins: [createFeatureFlagPlugin(features)],
})

console.timeEnd('build')

// Clean up generated stubs
if (stubs.length > 0) {
  await Promise.all(stubs.map(s => unlink(s).catch(() => {})))
  console.log(`  Removed ${stubs.length} stub file(s)`)
}

if (!result.success) {
  console.error('Build failed:')
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

// Prepend shebang and mark executable
const distFile = './dist/cli.js'
const original = await Bun.file(distFile).text()
await Bun.write(distFile, `#!/usr/bin/env node\n${original}`)
const { execSync } = await import('child_process')
execSync(`chmod +x ${distFile}`)

console.log('✓ Build complete → dist/cli.js')
console.log('  Run: ./dist/cli.js')
