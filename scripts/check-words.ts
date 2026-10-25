// Every message the API can show a person must have hi + bn words (src/content/words). Lint runs this; --missing lists the gaps.
/* eslint-disable security/detect-non-literal-fs-filename -- reads this repo's own src folder */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = join(__dirname, '..', 'src');
// Server-only text (env checks) and the platform team's console stay English.
const SKIP = [/^config[\\/]/, /^modules[\\/]admin[\\/](?!field|support)/];
const ZOD = new Set(['min', 'max', 'length', 'regex', 'email', 'uuid', 'url', 'refine', 'int', 'positive', 'nonnegative', 'nonempty', 'number', 'string', 'boolean', 'array', 'date', 'iso', 'enum', 'startsWith', 'endsWith', 'gt', 'gte', 'lt', 'lte', 'multipleOf', 'finite', 'safe']);

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));

// Functions that hand back a sentence to show: unitsProblem(), batchesTitle()…
const SAYS = /(Problem|Title)$/;
const WRAP = new Set(['String', 'Number', 'inr', 'rs', 'await', 'Math', 'abs', 'round', 'replace', 'toLowerCase', 'toUpperCase', 'join', 'toFixed', 'trim', 'day', 'pct']);

/** `${input.name} is out` → "{name} is out": the placeholder is the last plain word of the expression, made unique. */
function textOf(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (!ts.isTemplateExpression(node)) return null;
  let out = node.head.text;
  const used = new Set<string>();
  for (const span of node.templateSpans) {
    const words = span.expression.getText().replace(/'[^']*'|"[^"]*"/g, '').match(/[A-Za-z_]\w*/g) ?? [];
    const base = words.filter((w) => !WRAP.has(w)).pop() ?? 'x';
    let name = base;
    for (let i = 2; used.has(name); i += 1) name = `${base}${String(i)}`;
    used.add(name);
    out += `{${name}}${span.literal.text}`;
  }
  return out;
}

export function messagesIn(path: string): string[] {
  const src = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2023, true);
  const found: string[] = [];
  const consts = new Map<string, ts.Expression>();
  const helpers = new Map<string, number>();
  const fnName = (n: ts.Node) => (ts.isFunctionDeclaration(n) && n.name ? n.name.text : ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name) ? n.parent.name.text : null);
  const isAppError = (n: ts.CallExpression | ts.NewExpression) => n.expression.getText().startsWith('AppError.') || (ts.isNewExpression(n) && n.expression.getText() === 'AppError');
  const msgArg = (n: ts.CallExpression | ts.NewExpression) => (ts.isNewExpression(n) ? n.arguments?.[2] : n.arguments[0]);
  const scan = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) consts.set(n.name.text, n.initializer);
    if ((ts.isArrowFunction(n) || ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) && fnName(n)) {
      const params = n.parameters.map((p) => p.name.getText());
      const look = (m: ts.Node) => {
        if ((ts.isCallExpression(m) || ts.isNewExpression(m)) && isAppError(m)) {
          const arg = msgArg(m);
          const i = arg && ts.isIdentifier(arg) ? params.indexOf(arg.text) : -1;
          if (i >= 0) helpers.set(fnName(n) ?? '', i);
        }
        ts.forEachChild(m, look);
      };
      look(n.body ?? n);
    }
    ts.forEachChild(n, scan);
  };
  scan(src);

  const add = (n: ts.Node | undefined, depth = 0): void => {
    if (!n || depth > 4) return;
    if (ts.isParenthesizedExpression(n) || ts.isAwaitExpression(n)) return add(n.expression, depth);
    if (ts.isConditionalExpression(n)) {
      add(n.whenTrue, depth + 1);
      add(n.whenFalse, depth + 1);
      return;
    }
    if (ts.isBinaryExpression(n) && ['??', '||'].includes(n.operatorToken.getText())) {
      add(n.left, depth + 1);
      add(n.right, depth + 1);
      return;
    }
    if (ts.isIdentifier(n)) return add(consts.get(n.text), depth + 1);
    const t = textOf(n);
    if (t && /[a-z]/i.test(t.replace(/\{\w+\}/g, ''))) found.push(t);
  };
  const addProps = (n: ts.Node | undefined, deep = false, keys = ['message', 'error']) => {
    if (!n) return;
    if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) if (ts.isPropertyAssignment(p) && keys.includes(p.name.getText())) add(p.initializer);
    }
    if (deep) ts.forEachChild(n, (c) => { addProps(c, true, keys); });
  };
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const callee = n.expression.getText();
      const args = n.arguments ?? ts.factory.createNodeArray();
      if (isAppError(n)) {
        add(msgArg(n));
        for (const a of args) addProps(a, true);
      } else if (helpers.has(callee)) add(args[helpers.get(callee) ?? 0]);
      else if (callee === 'part' || callee === 'tr') add(args[0]);
      // Alerts and events: their title, body and item lines are read in the bell.
      else if (callee === 'alert' || callee === 'emit') for (const a of args) addProps(a, true, ['title', 'body', 'sub']);
      else if (/^(errors|warnings|notes)\.push$/.test(callee)) add(args[0]);
      else if (callee === 'sent' || callee === 'created') add(args[2]);
      else if (callee.endsWith('addIssue')) addProps(args[0]);
      else if (ts.isPropertyAccessExpression(n.expression) && ZOD.has(n.expression.name.text) && /\bz\b|\.(refine|min|max|regex)\(/.test(callee + n.getText())) {
        for (const a of args) {
          if (ts.isStringLiteral(a) || ts.isTemplateExpression(a) || ts.isNoSubstitutionTemplateLiteral(a) || ts.isConditionalExpression(a)) add(a);
          else addProps(a);
        }
      }
    }
    // A field error ({ field, message }) is shown under its box wherever it is built.
    if (ts.isObjectLiteralExpression(n) && ['field', 'message'].every((k) => n.properties.some((p) => p.name?.getText() === k))) addProps(n);
    if (ts.isReturnStatement(n) && n.expression) {
      let f: ts.Node = n.parent;
      while (!ts.isFunctionLike(f) && !ts.isSourceFile(f)) f = f.parent;
      if (SAYS.test(fnName(f) ?? '')) add(n.expression);
    }
    if (ts.isArrowFunction(n) && !ts.isBlock(n.body) && SAYS.test(fnName(n) ?? '')) add(n.body);
    ts.forEachChild(n, visit);
  };
  visit(src);
  return found;
}

export function allMessages(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files(ROOT)) {
    const rel = relative(ROOT, f);
    if (SKIP.some((r) => r.test(rel))) continue;
    for (const m of messagesIn(f)) if (!out.has(m)) out.set(m, rel);
  }
  return out;
}

if (require.main === module) {
  const all = allMessages();
  const book = (l: string) => JSON.parse(readFileSync(join(ROOT, 'content', 'words', `${l}.json`), 'utf8')) as Record<string, string>;
  const holes = (word: string) => [...word.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  let bad = 0;
  for (const lang of ['hi', 'bn']) {
    const words = book(lang);
    const missing = [...all.keys()].filter((m) => !(m in words));
    const extra = Object.keys(words).filter((k) => !all.has(k));
    const holed = Object.entries(words).filter(([k, v]) => all.has(k) && (holes(k) !== holes(v) || /\}\{/.test(k))).map(([k]) => k);
    if (process.argv.includes('--missing')) for (const m of missing) console.log(`${lang}\t${all.get(m) ?? ''}\t${m}`);
    if (missing.length || extra.length || holed.length) {
      bad += 1;
      console.error(`${lang}: ${missing.length} missing, ${extra.length} unused, ${holed.length} with wrong {placeholders}`);
      for (const k of [...extra, ...holed].slice(0, 20)) console.error(`  ${k}`);
    }
  }
  console.log(`${all.size} API messages`);
  if (bad) process.exit(1);
}
