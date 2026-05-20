#!/usr/bin/env node
/**
 * `actctl` — the actjs CLI.
 *
 * Phase 6.1 ships the `codegen` subcommand. Later phases will add
 * `manifest in-use`, `actor inspect`, etc. — they hang off the same
 * dispatcher.
 */
import { resolve } from 'node:path';

import { httpLoader, localLoader, type SourceLoader, type Target } from '../codegen/index.js';
import { run } from '../codegen/index.js';

interface ParsedArgs {
  readonly subcommand: string;
  readonly flags: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
  readonly positional: readonly string[];
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [subcommand = '', ...rest] = argv;
  const flags = new Map<string, string>();
  const switches = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else if (i + 1 < rest.length && !rest[i + 1]!.startsWith('--')) {
        flags.set(arg.slice(2), rest[++i]!);
      } else {
        switches.add(arg.slice(2));
      }
    } else {
      positional.push(arg);
    }
  }
  return { subcommand, flags, switches, positional };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.subcommand) {
    case 'codegen':
      await runCodegen(args);
      return;
    case 'help':
    case '--help':
    case '-h':
    case '':
      printUsage();
      return;
    default:
      console.error(`actctl: unknown subcommand "${args.subcommand}"`);
      printUsage();
      process.exit(2);
  }
}

function printUsage(): void {
  console.log(`actctl — actjs CLI

Usage:
  actctl <subcommand> [flags]

Subcommands:
  codegen     Generate .d.ts + manifest.json + runtime.js from class source.
  help        Show this message.

codegen flags:
  --source <spec>     local:<dir>  or  http:<base-url>     (required)
  --target <env>      dev | staging | prod  (HTTP source only; default prod)
  --token <token>     Bearer token for HTTP source.
  --out <dir>         Output directory.                   (default ./client-types)
  --root <dir>        Repo root for the .actctl cache.    (default --out)
  --check             Don't write; exit non-zero with diff if stale.
  --force             Ignore the incremental cache.

Examples:
  actctl codegen --source local:./classes --out ./client-types
  actctl codegen --source http://api.example.com --token $ADMIN_TOKEN --target prod
  actctl codegen --source local:./classes --out ./client-types --check
`);
}

async function runCodegen(args: ParsedArgs): Promise<void> {
  const spec = args.flags.get('source');
  if (!spec) {
    console.error('actctl codegen: --source is required');
    process.exit(2);
  }
  const outDir = resolve(args.flags.get('out') ?? './client-types');
  const rootDir = resolve(args.flags.get('root') ?? outDir);
  const force = args.switches.has('force');
  const check = args.switches.has('check');
  const target = (args.flags.get('target') ?? 'prod') as Target;

  let loader: SourceLoader;
  if (spec.startsWith('local:')) {
    const dir = resolve(spec.slice('local:'.length));
    loader = localLoader({ dir });
  } else if (spec.startsWith('http:') || spec.startsWith('https:')) {
    const token = args.flags.get('token') ?? process.env['ACTJS_ADMIN_TOKEN'];
    loader = httpLoader({
      baseUrl: spec,
      target,
      ...(token ? { token } : {}),
    });
  } else {
    console.error(`actctl codegen: unrecognized --source "${spec}"`);
    console.error('  expected local:<dir> or http(s)://<base-url>');
    process.exit(2);
    return;
  }

  const result = await run({ source: loader, outDir, rootDir, force, check });

  for (const w of result.warnings) {
    console.warn(`warning: ${w}`);
  }

  switch (result.status) {
    case 'wrote':
      console.log(`actctl codegen: wrote ${result.classes.length} classes`);
      console.log(`  manifest sha: ${result.manifestSha}`);
      console.log(`  output dir:   ${outDir}`);
      return;
    case 'skipped':
      console.log(
        `actctl codegen: up-to-date (manifest sha ${result.manifestSha.slice(0, 12)}…); use --force to regenerate`,
      );
      return;
    case 'check-clean':
      console.log(`actctl codegen --check: committed output is up to date`);
      return;
    case 'check-drift':
      console.error(`actctl codegen --check: committed output is stale`);
      console.error(result.diff ?? '(no diff produced)');
      process.exit(1);
  }
}

void main().catch((err) => {
  console.error(`actctl: ${err instanceof Error ? err.message : String(err)}`);
  if (process.env['ACTCTL_DEBUG'] === '1') {
    console.error(err);
  }
  process.exit(1);
});
