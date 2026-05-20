/**
 * Extract handler signatures, state shape, and ES metadata from a
 * single class's TypeScript source.
 *
 * The TS compiler API parses the source into an AST. We do **not**
 * run the type checker: extraction operates purely on the syntactic
 * shape that classes are required to author in (see
 * docs/codegen.md#supported-shape). This keeps codegen fast and
 * deterministic — the same source bytes always produce the same
 * output regardless of which packages happen to be installed.
 *
 * Supported authoring shapes (see ADR for full table):
 *
 *   class Cart extends actjs.Actor<{ items: Item[] }> {
 *     @handler('addItem')
 *     addItem(args: { sku: string; qty: number }): { total: number } { ... }
 *   }
 *
 *   class Ledger extends actjs.EventSourced<{ balance: number }, LedgerEvent> {
 *     reduce(state: { balance: number }, event: LedgerEvent) { ... }
 *     @handler('credit')
 *     credit(args: { amount: number }): LedgerEvent[] { ... }
 *   }
 *
 * Unsupported (rejected with a warning, handler still listed with
 * `unknown` types so the user can fix it without losing the rest of
 * the output): generic handlers, conditional return types, mapped
 * types referencing non-exported aliases.
 */
import { createHash } from 'node:crypto';

import ts from 'typescript';

import type { CodegenInput, ExtractedClass, ExtractedHandler } from './types.js';

const UNKNOWN_TYPE = 'unknown';
const NEVER_TYPE = 'never';

export function extractClass(input: CodegenInput): ExtractedClass {
  const filename = `${input.className}.ts`;
  const source = ts.createSourceFile(
    filename,
    input.source,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const classDecl = findFirstClassDeclaration(source);
  const warnings: string[] = [];
  const handlers: ExtractedHandler[] = [];
  let stateType = UNKNOWN_TYPE;
  let eventType = NEVER_TYPE;
  let eventSourced = false;
  let reduceBody: string | null = null;
  let reduceParams: { state: string; event: string } | null = null;

  if (!classDecl) {
    warnings.push(`no class declaration found in ${input.className}`);
  } else {
    const heritage = classDecl.heritageClauses?.[0]?.types[0];
    if (heritage) {
      eventSourced = isEventSourcedHeritage(heritage);
      const inferred = inferStateAndEventFromHeritage(heritage, eventSourced);
      stateType = resolveLocalAlias(source, inferred.state) ?? inferred.state;
      const ev = resolveLocalAlias(source, inferred.event) ?? inferred.event;
      eventType = ev;
    }

    for (const member of classDecl.members) {
      if (ts.isMethodDeclaration(member)) {
        const methodName = nameOf(member.name);
        if (eventSourced && methodName === 'reduce') {
          reduceBody = printBody(member, source);
          reduceParams = paramNamesOf(member);
          continue;
        }
        const handlerNameOrNull = handlerNameFromDecorators(member, source);
        if (handlerNameOrNull === null) continue;
        const handler = extractHandler(member, source, handlerNameOrNull, warnings);
        if (handler) handlers.push(handler);
      }
    }
  }

  return {
    name: input.className,
    version: input.version,
    sourceSha256: createHash('sha256').update(input.source, 'utf8').digest('hex'),
    eventSourced,
    stateType,
    eventType: eventSourced ? eventType : NEVER_TYPE,
    reduceBody,
    reduceParams,
    handlers,
    warnings,
  };
}

/* ------------------------------------------------------- Helpers */

function findFirstClassDeclaration(source: ts.SourceFile): ts.ClassDeclaration | null {
  for (const stmt of source.statements) {
    if (ts.isClassDeclaration(stmt)) return stmt;
    // The published source is authored as a function body. Look one
    // level deeper inside `return class …` and `class … return …`.
    if (ts.isReturnStatement(stmt) && stmt.expression && ts.isClassExpression(stmt.expression)) {
      return classExpressionToDeclaration(stmt.expression);
    }
  }
  // Last resort: scan for a class expression anywhere in the file.
  let found: ts.ClassExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isClassExpression(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (found) return classExpressionToDeclaration(found);
  return null;
}

/**
 * A `class … {}` expression has identical members to a class
 * declaration; the TS types differ in name only. We narrow by
 * structural casting since we only read members/heritageClauses.
 */
function classExpressionToDeclaration(expr: ts.ClassExpression): ts.ClassDeclaration {
  return expr as unknown as ts.ClassDeclaration;
}

function isEventSourcedHeritage(heritage: ts.ExpressionWithTypeArguments): boolean {
  const text = heritage.expression.getText();
  // Accept `actjs.EventSourced`, `EventSourced`, and any `*.EventSourced`.
  return /(^|\.)EventSourced$/.test(text);
}

function inferStateAndEventFromHeritage(
  heritage: ts.ExpressionWithTypeArguments,
  eventSourced: boolean,
): { state: string; event: string } {
  const args = heritage.typeArguments;
  if (!args || args.length === 0) {
    return { state: UNKNOWN_TYPE, event: NEVER_TYPE };
  }
  const state = args[0]?.getText() ?? UNKNOWN_TYPE;
  if (eventSourced) {
    const ev = args[1]?.getText() ?? NEVER_TYPE;
    return { state, event: ev };
  }
  return { state, event: NEVER_TYPE };
}

function nameOf(node: ts.PropertyName): string {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return node.getText();
}

function paramNamesOf(method: ts.MethodDeclaration): { state: string; event: string } | null {
  const p0 = method.parameters[0];
  const p1 = method.parameters[1];
  if (!p0 || !p1) return null;
  const stateName = ts.isIdentifier(p0.name) ? p0.name.text : 'state';
  const eventName = ts.isIdentifier(p1.name) ? p1.name.text : 'event';
  return { state: stateName, event: eventName };
}

function handlerNameFromDecorators(
  method: ts.MethodDeclaration,
  _source: ts.SourceFile,
): string | null {
  // TS modifiers/decorators in current AST: combined `modifiers` array.
  const modifiers = method.modifiers ?? [];
  for (const m of modifiers) {
    if (!ts.isDecorator(m)) continue;
    const expr = m.expression;
    if (!ts.isCallExpression(expr)) continue;
    const callee = expr.expression;
    const calleeName = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : callee.getText();
    if (calleeName !== 'handler') continue;
    const firstArg = expr.arguments[0];
    if (firstArg && ts.isStringLiteralLike(firstArg)) {
      return firstArg.text;
    }
    // `@handler()` with no arg → method's declared name.
    return nameOf(method.name);
  }
  return null;
}

function extractHandler(
  method: ts.MethodDeclaration,
  source: ts.SourceFile,
  handlerName: string,
  warnings: string[],
): ExtractedHandler | null {
  if (method.typeParameters && method.typeParameters.length > 0) {
    warnings.push(
      `handler ${handlerName} declares generic type parameters; emitted as unknown — see docs/codegen.md`,
    );
    return {
      name: handlerName,
      argsType: UNKNOWN_TYPE,
      returnType: UNKNOWN_TYPE,
      esEventReturn: false,
    };
  }
  const firstParam = method.parameters[0];
  const argsType = firstParam?.type !== undefined ? firstParam.type.getText(source) : UNKNOWN_TYPE;
  const declaredReturn = method.type ? method.type.getText(source) : UNKNOWN_TYPE;
  const { returnType, esEventReturn } = unwrapPromise(declaredReturn);
  return {
    name: handlerName,
    argsType,
    returnType,
    esEventReturn,
  };
}

function unwrapPromise(t: string): { returnType: string; esEventReturn: boolean } {
  // Strip a single Promise<…> wrapper. This is a syntactic peel —
  // the type checker isn't running — so nested promises or aliases
  // pass through unchanged, which is fine: the SDK awaits whatever
  // comes back anyway.
  const promiseMatch = /^Promise<([\s\S]+)>$/.exec(t.trim());
  const inner = promiseMatch ? promiseMatch[1]!.trim() : t.trim();
  const esEventReturn = /\[\]$/.test(inner) && /Event/.test(inner);
  return { returnType: inner, esEventReturn };
}

/**
 * Resolve a bare type identifier (e.g. `LedgerEvent`) to its locally
 * declared body by scanning top-level `type X = …` aliases. Returns
 * null for built-ins or anything not declared in this file.
 *
 * Inlining here keeps the emitted `.d.ts` self-contained: client
 * code shouldn't need to import the per-class source helper types.
 */
function resolveLocalAlias(source: ts.SourceFile, identifier: string): string | null {
  // Strip the trivial cases — primitives, anonymous shapes, `never`.
  if (!/^[A-Za-z_$][\w$]*$/.test(identifier.trim())) return null;
  const target = identifier.trim();
  for (const stmt of source.statements) {
    if (!ts.isTypeAliasDeclaration(stmt)) continue;
    if (stmt.name.text !== target) continue;
    return stmt.type.getText(source);
  }
  return null;
}

function printBody(method: ts.MethodDeclaration, source: ts.SourceFile): string | null {
  if (!method.body) return null;
  // `getFullText()` includes leading trivia; we want just the body
  // text starting at `{`. `getText` on the body without source returns
  // the printed form; passing source preserves byte-equivalence.
  return method.body.getText(source);
}
