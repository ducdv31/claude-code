/**
 * Build script for Claude Code CLI
 * Requires Bun: https://bun.sh
 * Run: bun run build.ts
 */
import type { BunPlugin } from 'bun'
import { existsSync } from 'fs'
import * as path from 'path'

// ---------------------------------------------------------------------------
// Feature flags — controls dead-code elimination at bundle time.
// Set to `true` to include the feature, `false` to strip it out.
// Flags that depend on private Anthropic packages (@ant/*) must stay false.
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
  CACHED_MICROCOMPACT: false,   // cachedMicrocompact.ts not in this repo
  CCR_AUTO_CONNECT: false,
  CCR_MIRROR: false,
  CCR_REMOTE_SETUP: false,
  CHICAGO_MCP: false,           // requires private @ant/computer-use-mcp
  COMMIT_ATTRIBUTION: false,    // attributionTrailer.ts not in this repo
  COMPACTION_REMINDERS: true,
  CONNECTOR_TEXT: false,        // types/connectorText.ts not in this repo
  CONTEXT_COLLAPSE: false,      // services/contextCollapse not in this repo
  COORDINATOR_MODE: false,
  COWORKER_TYPE_TELEMETRY: false,
  DAEMON: false,
  DIRECT_CONNECT: false,
  DOWNLOAD_USER_SETTINGS: false,
  DUMP_SYSTEM_PROMPT: false,
  ENHANCED_TELEMETRY_BETA: false,
  EXPERIMENTAL_SKILL_SEARCH: false,
  EXTRACT_MEMORIES: true,
  FILE_PERSISTENCE: false,      // utils/filePersistence/types.ts not in this repo
  FORK_SUBAGENT: false,
  HARD_FAIL: false,
  HISTORY_PICKER: true,
  HISTORY_SNIP: false,
  HOOK_PROMPTS: false,
  IS_LIBC_GLIBC: false,
  IS_LIBC_MUSL: false,
  KAIROS: false,                // requires private assistant module
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
  REACTIVE_COMPACT: false,      // services/compact/reactiveCompact.ts not in this repo
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
  VOICE_MODE: false,            // requires voice hardware/private packages
  WEB_BROWSER_TOOL: false,     // requires private @ant/claude-for-chrome-mcp
  WORKFLOW_SCRIPTS: false,     // tools/WorkflowTool not in this repo
}

// ---------------------------------------------------------------------------
// Plugin 1: Feature flags
// Replaces feature('FLAG') → true/false in source text before Bun parses it,
// enabling proper tree-shaking of dead branches.
// Also stubs out the bun:bundle virtual import.
// ---------------------------------------------------------------------------
function createFeatureFlagPlugin(featureMap: Record<string, boolean>): BunPlugin {
  return {
    name: 'feature-flags',
    setup(build) {
      // Redirect `bun:bundle` to a no-op shim (call sites are already rewritten)
      build.onResolve({ filter: /^bun:bundle$/ }, () => ({
        path: 'bun-bundle-shim',
        namespace: 'virtual',
      }))

      // Replace feature('FLAG') calls with literals before Bun parses the file
      build.onLoad({ filter: /\.(ts|tsx)$/ }, async (args) => {
        let contents = await Bun.file(args.path).text()
        for (const [name, enabled] of Object.entries(featureMap)) {
          const value = String(enabled)
          contents = contents.replaceAll(`feature('${name}')`, value)
          contents = contents.replaceAll(`feature("${name}")`, value)
        }
        return { contents, loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts' }
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Plugin 2: Virtual / stub modules
// Handles several categories of unresolvable imports:
//   a) bun:bundle shim (registered by plugin 1 above)
//   b) Missing internal source files (not included in this partial repo dump)
//   c) Type-declaration files (.d.ts) imported at runtime
//   d) Markdown files imported as text
// ---------------------------------------------------------------------------
function createStubPlugin(): BunPlugin {
  // Candidate extensions to check when a .js extension is used in an import
  const TS_EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx', '.js', '/index.js']

  function fileExistsWithExtensions(base: string): boolean {
    if (existsSync(base)) return true
    for (const ext of TS_EXTENSIONS) {
      if (existsSync(base + ext)) return true
    }
    return false
  }

  return {
    name: 'stub-missing',
    setup(build) {
      // (a) bun:bundle shim content
      build.onLoad({ filter: /.*/, namespace: 'virtual' }, () => ({
        contents: 'export function feature(_name) { return false }',
        loader: 'js',
      }))

      // (b) Stub missing relative imports (internal modules not in this repo)
      build.onResolve({ filter: /^\./ }, (args) => {
        // Skip .d.ts type imports — always stub them (no runtime value)
        if (args.path.endsWith('.d.ts')) {
          return { path: args.path, namespace: 'stub' }
        }

        const baseDir = path.dirname(args.importer)
        const resolved = path.resolve(baseDir, args.path)

        if (fileExistsWithExtensions(resolved)) {
          return null // file exists — let Bun resolve it normally
        }

        // File not found → return empty stub
        return { path: args.path, namespace: 'stub' }
      })

      // (c) Stub content for missing internal modules
      build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
        // Export an empty module; named exports default to undefined at runtime.
        // Most missing modules are either feature-gated (DCE'd) or optional.
        contents: `// auto-stub: ${args.path}\nexport default {};\n`,
        loader: 'js',
      }))

      // (d) Markdown files — import as plain string
      build.onLoad({ filter: /\.md$/ }, async (args) => ({
        contents: `export default ${JSON.stringify(await Bun.file(args.path).text())};`,
        loader: 'js',
      }))
    },
  }
}

// ---------------------------------------------------------------------------
// Optional npm packages — dynamically imported, not shipped in this build.
// Marking them external prevents bundle errors; they fail gracefully at
// runtime only when the user actually enables the feature.
// ---------------------------------------------------------------------------
const externalPackages = [
  // Private Anthropic internal packages (never on npm)
  '@ant/claude-for-chrome-mcp',
  '@ant/computer-use-input',
  '@ant/computer-use-mcp',
  '@ant/computer-use-swift',
  '@anthropic-ai/mcpb',
  '@anthropic-ai/sandbox-runtime',
  'color-diff-napi',            // native binary, not on npm

  // Optional cloud provider SDKs (user installs if they use Bedrock/Vertex/etc.)
  '@anthropic-ai/bedrock-sdk',
  '@anthropic-ai/foundry-sdk',
  '@anthropic-ai/vertex-sdk',
  '@azure/identity',

  // Optional OpenTelemetry exporters (user installs if they configure OTLP)
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

  // Optional native modules
  'sharp',                      // image processing (optional)
]

// ---------------------------------------------------------------------------
// MACRO.* — dotted-identifier defines, valid in Bun/esbuild define syntax
// ---------------------------------------------------------------------------
const macroDefines: Record<string, string> = {
  'MACRO.VERSION': JSON.stringify('1.0.0'),
  'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
  'MACRO.FEEDBACK_CHANNEL': JSON.stringify(
    'https://github.com/anthropics/claude-code/issues',
  ),
  'MACRO.ISSUES_EXPLAINER': JSON.stringify(
    'Report issues at https://github.com/anthropics/claude-code/issues',
  ),
  'MACRO.NATIVE_PACKAGE_URL': JSON.stringify(''),
  'MACRO.PACKAGE_URL': JSON.stringify('npm:@anthropic-ai/claude-code'),
  'MACRO.VERSION_CHANGELOG': JSON.stringify(''),
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
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
  plugins: [
    createFeatureFlagPlugin(features),
    createStubPlugin(),
  ],
})

console.timeEnd('build')

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
