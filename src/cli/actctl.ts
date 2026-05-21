#!/usr/bin/env node
/**
 * `actctl` — the actjs CLI.
 *
 * Phase 6.1 ships the `codegen` subcommand. Later phases will add
 * `manifest in-use`, `actor inspect`, etc. — they hang off the same
 * dispatcher.
 */
import { createHash, createPrivateKey, sign as nodeSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
    case 'key':
      await runKey(args);
      return;
    case 'publish':
      await runPublish(args);
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
  key add     POST a signing public key to the server.
  key revoke  Revoke a signing key by kid.
  publish     Publish a class version; optionally sign it.
  help        Show this message.

codegen flags:
  --source <spec>     local:<dir>  or  http:<base-url>     (required)
  --target <env>      dev | staging | prod  (HTTP source only; default prod)
  --token <token>     Bearer token for HTTP source.
  --out <dir>         Output directory.                   (default ./client-types)
  --root <dir>        Repo root for the .actctl cache.    (default --out)
  --check             Don't write; exit non-zero with diff if stale.
  --force             Ignore the incremental cache.

key add flags:
  --server <url>      Server base URL.                     (required)
  --kid <id>          Identifier for the key.              (required)
  --pem <path>        Path to the public-key PEM.          (required)
  --token <token>     Admin bearer token.

key revoke flags:
  --server <url>      Server base URL.                     (required)
  --kid <id>          Key id to revoke.                    (required)
  --token <token>     Admin bearer token.

publish flags:
  --server <url>      Server base URL.                     (required)
  --name <class>      Class name.                          (required)
  --version <ver>     Semver version.                      (required)
  --source <path>     TS source file.                      (required)
  --sign <path>       Ed25519 private-key PEM (optional).
  --kid <id>          Key id; required with --sign.
  --token <token>     Admin bearer token.

Examples:
  actctl codegen --source local:./classes --out ./client-types
  actctl key add --server http://api --kid k1 --pem k1.pub.pem
  actctl publish --server http://api --name Note --version 1.0.0 --source Note.ts \\
                 --sign k1.priv.pem --kid k1
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

async function runKey(args: ParsedArgs): Promise<void> {
  const op = args.positional[0];
  const server = requireFlag(args, 'server');
  const kid = requireFlag(args, 'kid');
  const token = args.flags.get('token') ?? process.env['ACTJS_ADMIN_TOKEN'];
  const url = new URL(`/v1/admin/signing-keys/${encodeURIComponent(kid)}`, server).toString();
  if (op === 'add') {
    const pemPath = requireFlag(args, 'pem');
    const pem = readFileSync(resolve(pemPath), 'utf8');
    const resp = await fetch(url, {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({ publicKeyPem: pem }),
    });
    if (!resp.ok) failHttp('key add', resp);
    console.log(`actctl key add: registered ${kid}`);
    return;
  }
  if (op === 'revoke') {
    const resp = await fetch(url, { method: 'DELETE', headers: authHeaders(token) });
    if (!resp.ok) failHttp('key revoke', resp);
    console.log(`actctl key revoke: revoked ${kid}`);
    return;
  }
  console.error(`actctl key: unknown operation "${op ?? ''}"`);
  process.exit(2);
}

async function runPublish(args: ParsedArgs): Promise<void> {
  const server = requireFlag(args, 'server');
  const name = requireFlag(args, 'name');
  const version = requireFlag(args, 'version');
  const sourcePath = requireFlag(args, 'source');
  const token = args.flags.get('token') ?? process.env['ACTJS_ADMIN_TOKEN'];
  const source = readFileSync(resolve(sourcePath), 'utf8');

  const signPath = args.flags.get('sign');
  let signature: { kid: string; signature: string } | null = null;
  if (signPath) {
    const kid = requireFlag(args, 'kid');
    const pem = readFileSync(resolve(signPath), 'utf8');
    const sha = createHash('sha256').update(source, 'utf8').digest('hex');
    const message = Buffer.from(`sha256:${sha}|${name}@${version}`, 'utf8');
    const sig = nodeSign(null, message, createPrivateKey(pem));
    signature = { kid, signature: sig.toString('base64') };
  }

  const url = new URL(`/v1/classes/${encodeURIComponent(name)}/versions`, server).toString();
  const body: Record<string, unknown> = { version, source };
  if (signature) {
    body['kid'] = signature.kid;
    body['signature'] = signature.signature;
  }
  const resp = await fetch(url, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify(body),
  });
  if (!resp.ok) failHttp('publish', resp);
  const data = (await resp.json()) as {
    name: string;
    version: string;
    sha256: string;
    signedBy?: string;
  };
  console.log(`actctl publish: ${data.name}@${data.version} sha=${data.sha256.slice(0, 12)}…`);
  if (data.signedBy) console.log(`  signed by ${data.signedBy}`);
}

function requireFlag(args: ParsedArgs, name: string): string {
  const v = args.flags.get(name);
  if (!v) {
    console.error(`actctl: --${name} is required`);
    process.exit(2);
  }
  return v;
}

function authHeaders(token: string | undefined): Record<string, string> {
  const h: Record<string, string> = { 'X-Actjs-Admin': '1' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

function jsonHeaders(token: string | undefined): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

function failHttp(op: string, resp: Response): never {
  console.error(`actctl ${op}: HTTP ${resp.status} ${resp.statusText}`);
  process.exit(1);
}

void main().catch((err) => {
  console.error(`actctl: ${err instanceof Error ? err.message : String(err)}`);
  if (process.env['ACTCTL_DEBUG'] === '1') {
    console.error(err);
  }
  process.exit(1);
});
