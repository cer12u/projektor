import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { collect, generated, manifest, sqlCheck } from "./catalogs.mjs";

const sourcePattern = /\.(?:[cm]?[jt]sx?)$/;
const excluded = new Set([
  "node_modules",
  ".astro",
  ".git",
  "dist",
  ".tmp",
  "coverage",
  "reports",
  ".pnpm-store",
  "__pycache__",
]);
export function sources(root, directory = "", pattern = sourcePattern) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    if (excluded.has(entry.name)) return [];
    const file = path.posix.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`import: symlink source not allowed: ${file}`);
    return entry.isDirectory() ? sources(root, file, pattern) : pattern.test(file) ? [file] : [];
  });
}
const bannedType =
  /^(?:SQL|SQLQuery|SQLFragment|D1.*|Drizzle.*|Env|ModuleStore|.*Transaction.*|KVNamespace|R2Bucket|R2Object.*|DatabaseSync)$/i;
const bannedMember = /^(?:execute|query|tableName|prepare|transaction|sql|raw|binding|bindings)$/i;
const sqlStart =
  /^\s*(?:SELECT\s|WITH\s|INSERT\s|UPDATE\s|DELETE\s|CREATE\s|DROP\s|ALTER\s|ATTACH\s|PRAGMA\s)/i;

function cycle(graph, report, label) {
  const done = new Set();
  const active = new Set();
  function visit(id, stack) {
    if (active.has(id)) {
      report("import", `${label} cycle: ${[...stack, id].join(" -> ")}`);
      return;
    }
    if (done.has(id)) return;
    active.add(id);
    for (const dep of graph.get(id) ?? []) visit(dep, [...stack, id]);
    active.delete(id);
    done.add(id);
  }
  for (const id of graph.keys()) visit(id, []);
}

export function check(root = process.cwd(), onlyRule, { freshness = true } = {}) {
  const errors = [];
  const report = (rule, message) => errors.push({ rule, message });
  const owners = manifest(root).owners;
  const ownerOf = (file) => owners.filter((owner) => file.startsWith(`${owner.root}/`));
  const files = sources(root);
  const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile).config;
  const options = ts.parseJsonConfigFileContent(config, ts.sys, root).options;
  const program = ts.createProgram(
    files.filter((f) => /\.tsx?$/.test(f)).map((f) => path.join(root, f)),
    options,
  );
  const checker = program.getTypeChecker();
  const dag = new Map(owners.map((owner) => [owner.id, owner.dependencies]));
  const fileGraph = new Map();
  const seenOwners = new Set();
  const prefixes = { kvPrefix: [], r2Prefix: [], prefix: [] };
  for (const owner of owners) {
    if (seenOwners.has(owner.id) || owner.root.includes("..") || path.isAbsolute(owner.root))
      report("import", `invalid/duplicate owner ${owner.id}`);
    seenOwners.add(owner.id);
    for (const dependency of owner.dependencies)
      if (!owners.some((other) => other.id === dependency))
        report("import", `unknown dependency ${dependency}`);
    if (owner.storage) {
      if (!["module", "platform"].includes(owner.kind))
        report("capability", `${owner.id}: storage is forbidden for ${owner.kind}`);
      if (
        owner.storage.catalog !== `${owner.root}/storage/queries.ts` ||
        owner.storage.migrations !== `${owner.root}/storage/migrations`
      )
        report("sql-static", `${owner.id}: storage path outside owner`);
      for (const key of Object.keys(prefixes)) {
        const prefix = owner.storage[key];
        if (!prefix) continue;
        if (prefixes[key].some((other) => prefix.startsWith(other) || other.startsWith(prefix)))
          report("capability", `${owner.id}: overlapping ${key}`);
        prefixes[key].push(prefix);
      }
    }
  }
  cycle(dag, report, "owner (including type-only/event dependencies)");
  for (const file of sources(root, "", /\.sql$/)) {
    const matches = ownerOf(file);
    if (matches.length === 1 && matches[0].kind === "web") continue;
    if (matches.length !== 1 || path.posix.dirname(file) !== matches[0].storage?.migrations)
      report("sql-static", `SQL outside owner migrations: ${file}`);
  }

  for (const file of files) {
    const matches = ownerOf(file);
    if (matches.length !== 1) {
      report("import", `source must have exactly one owner: ${file}`);
      continue;
    }
    const owner = matches[0];
    if (
      owner.kind !== "tooling" &&
      file !== "apps/worker/index.ts" &&
      file !== "tools/check-boundaries.mjs" &&
      /\bINTEGRATIONS_KEY\b/.test(fs.readFileSync(path.join(root, file), "utf8"))
    )
      report("capability", `${file}: integration key outside Worker composition`);
    const source =
      program.getSourceFile(path.join(root, file)) ??
      ts.createSourceFile(
        file,
        fs.readFileSync(path.join(root, file), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
    const privileged = ["platform", "composition", "tooling"].includes(owner.kind);
    const imports = [];
    const edges = [];
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
        imports.push(node.moduleSpecifier);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
        imports.push(node.argument.literal);
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression
      )
        imports.push(node.moduleReference.expression);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          node.expression.getText(source) === "require")
      ) {
        if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) {
          if (owner.kind === "web") return;
          report("import", `${file}: non-literal import/require`);
        } else imports.push(node.arguments[0]);
      }
      if (owner.kind !== "tooling" && owner.kind !== "web") {
        if (
          node.kind === ts.SyntaxKind.AnyKeyword ||
          (ts.isAsExpression(node) &&
            (ts.isAsExpression(node.expression) || node.type.kind === ts.SyntaxKind.UnknownKeyword))
        )
          report("capability", `${file}: any/double cast is forbidden`);
        if (ts.isIdentifier(node) && ["eval", "Function", "require"].includes(node.text)) {
          // Literal require is resolved below; passing require around is not permitted.
          if (
            !(
              node.text === "require" &&
              ts.isCallExpression(node.parent) &&
              node.parent.expression === node
            )
          )
            report("capability", `${file}: runtime evaluation/loader alias`);
        }
        const allowedStore =
          node.text === "ModuleStore" && owner.kind === "module" && file !== owner.public;
        if (!privileged && ts.isIdentifier(node) && bannedType.test(node.text) && !allowedStore)
          report("capability", `${file}: raw/storage type ${node.text} outside platform`);
        if (
          ts.isElementAccessExpression(node) &&
          ts.isStringLiteralLike(node.argumentExpression) &&
          ["eval", "Function"].includes(node.argumentExpression.text)
        )
          report("capability", `${file}: runtime evaluation`);
        if (
          !privileged &&
          ts.isPropertyAccessExpression(node) &&
          ["prepare", "exec"].includes(node.name.text)
        )
          report("capability", `${file}: raw DB operation`);
        if (
          (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) &&
          sqlStart.test(ts.isTemplateExpression(node) ? node.head.text : node.text)
        ) {
          if (file !== owner.storage?.catalog && !file.startsWith("platform/generated/"))
            report("sql-static", `${file}: SQL outside named catalog`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const specifier of imports) {
      if (!ts.isStringLiteralLike(specifier)) {
        report("import", `${file}: non-literal module reference`);
        continue;
      }
      const name = specifier.text;
      if (owner.kind === "tooling" && name === "../.tmp/test-entry.mjs") continue;
      const resolution = ts.resolveModuleName(
        name,
        path.join(root, file),
        options,
        ts.sys,
      ).resolvedModule;
      if (owner.kind === "web") {
        if (resolution && !resolution.resolvedFileName.includes("/node_modules/")) {
          const target = path.relative(root, resolution.resolvedFileName).replaceAll(path.sep, "/");
          if (!target.startsWith(`${owner.root}/`))
            report("import", `${file}: Web import outside web root: ${target}`);
          else edges.push(target);
        } else if (name.startsWith(".") || name.startsWith("/")) {
          report("import", `${file}: unresolved Web import ${name}`);
        }
        continue;
      }
      if (!resolution || resolution.resolvedFileName.includes("/node_modules/")) {
        if (
          !owner.external.some((allowed) =>
            allowed.endsWith(":*")
              ? name.startsWith(allowed.slice(0, -1))
              : name === allowed || name.startsWith(`${allowed}/`),
          )
        )
          report("import", `${file}: unapproved/unresolved package ${name}`);
        continue;
      }
      const target = path.relative(root, resolution.resolvedFileName).replaceAll(path.sep, "/");
      edges.push(target);
      const targetOwners = ownerOf(target);
      if (targetOwners.length !== 1) {
        report("import", `${file}: target has no unique owner: ${target}`);
        continue;
      }
      const provider = targetOwners[0];
      if (provider.id === owner.id) continue;
      if (!owner.dependencies.includes(provider.id))
        report("import", `${file}: undeclared dependency ${provider.id}`);
      const compositionEntry =
        owner.kind === "composition" &&
        (target === provider.factory || provider.kind === "platform");
      const tooling = owner.kind === "tooling";
      if (!tooling && !compositionEntry && target !== provider.public)
        report("import", `${file}: private import ${target}`);
      if (owner.kind === "web" && target !== "gateway/wire.ts")
        report("import", `${file}: Web may import only Gateway wire contract`);
    }
    fileGraph.set(file, owner.kind === "web" ? [] : edges);
  }
  cycle(fileGraph, report, "source");

  // Walk compiler types, not only source spellings: aliases, barrels, inferred
  // return types and nested generic arguments must not hide a storage capability.
  for (const owner of owners.filter((o) => o.public && ["module", "gateway"].includes(o.kind))) {
    const file = program.getSourceFile(path.join(root, owner.public));
    if (!file) {
      report("public-type", `${owner.id}: missing public entry`);
      continue;
    }
    const symbol = checker.getSymbolAtLocation(file);
    const visited = new Set();
    const signatureSymbols = new Set();
    function inspectSignatureSymbol(symbol) {
      if (!symbol || signatureSymbols.has(symbol)) return;
      signatureSymbols.add(symbol);
      if (symbol.flags & ts.SymbolFlags.Alias)
        return inspectSignatureSymbol(checker.getAliasedSymbol(symbol));
      if (bannedType.test(symbol.name))
        report("public-type", `${owner.id}: signature leaks ${symbol.name}`);
      for (const declaration of symbol.declarations ?? []) {
        if (
          !declaration.getSourceFile().fileName.startsWith(root) ||
          declaration.getSourceFile().fileName.includes("/node_modules/")
        )
          continue;
        function walk(node) {
          // An implementation may legitimately use private storage. Only its
          // signature and inferred output belong to the public contract.
          if (ts.isBlock(node)) return;
          if (ts.isTypeReferenceNode(node))
            inspectSignatureSymbol(checker.getSymbolAtLocation(node.typeName));
          ts.forEachChild(node, walk);
        }
        walk(declaration);
      }
    }
    function inspect(type, trail) {
      if (!type || visited.has(type)) return;
      visited.add(type);
      if (type.flags & ts.TypeFlags.StringLiteral && sqlStart.test(type.value))
        report("public-type", `${owner.id}: ${trail} exports SQL text`);
      if (
        type.flags &
        (ts.TypeFlags.StringLike |
          ts.TypeFlags.NumberLike |
          ts.TypeFlags.BooleanLike |
          ts.TypeFlags.ESSymbolLike |
          ts.TypeFlags.Null |
          ts.TypeFlags.Undefined |
          ts.TypeFlags.Void |
          ts.TypeFlags.Never |
          ts.TypeFlags.Unknown)
      )
        return;
      const name = type.aliasSymbol?.name ?? type.symbol?.name;
      if ([name, type.symbol?.name].some((name) => name && bannedType.test(name)))
        report("public-type", `${owner.id}: ${trail} leaks ${name}`);
      if (type.flags & ts.TypeFlags.Any) report("public-type", `${owner.id}: ${trail} leaks any`);
      if (owner.kind === "gateway" && ["Request", "Response"].includes(name)) return;
      if (type.isUnionOrIntersection()) {
        for (const part of type.types) inspect(part, trail);
        // Every union constituent was checked. Traversing the union's merged
        // properties again visits ambient String methods for literal unions.
        if (type.isUnion()) return;
      }
      for (const argument of type.aliasTypeArguments ?? []) inspect(argument, trail);
      if (type.objectFlags & ts.ObjectFlags.Reference)
        for (const argument of checker.getTypeArguments(type)) inspect(argument, trail);
      // Standard-library containers are checked via their type arguments; no need
      // to traverse Promise/Array/Response methods (which have ambient overloads).
      const declarations = type.symbol?.declarations ?? [];
      if (
        declarations.length &&
        declarations.every((d) => d.getSourceFile().fileName.includes("/node_modules/"))
      ) {
        if (
          !/^(?:Promise|ReadonlyArray|Array|Request|Response|ArrayBuffer|String|Number|Boolean)$/.test(
            name ?? "",
          )
        )
          report("public-type", `${owner.id}: external public type ${name}`);
        return;
      }
      for (const property of type.getProperties()) {
        if (bannedMember.test(property.name))
          report("public-type", `${owner.id}: ${trail}.${property.name} is a storage interface`);
        const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? file;
        inspect(
          checker.getTypeOfSymbolAtLocation(property, declaration),
          `${trail}.${property.name}`,
        );
      }
      for (const signature of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
        inspect(signature.getReturnType(), `${trail} result`);
        for (const parameter of signature.parameters) {
          const pt = checker.getTypeOfSymbolAtLocation(
            parameter,
            parameter.valueDeclaration ?? file,
          );
          if (pt.getCallSignatures().length)
            report("public-type", `${owner.id}: callback capability parameter ${parameter.name}`);
          inspect(pt, `${trail} parameter ${parameter.name}`);
        }
      }
      for (const index of checker.getIndexInfosOfType(type)) inspect(index.type, `${trail} index`);
    }
    if (symbol)
      for (let exported of checker.getExportsOfModule(symbol)) {
        if (exported.flags & ts.SymbolFlags.Alias) exported = checker.getAliasedSymbol(exported);
        if (
          bannedType.test(exported.name) ||
          bannedMember.test(exported.name) ||
          /^(?:create.*Store|.*Factory)$/.test(exported.name)
        )
          report("public-type", `${owner.id}: forbidden export ${exported.name}`);
        inspectSignatureSymbol(exported);
        inspect(
          exported.flags & ts.SymbolFlags.Type
            ? checker.getDeclaredTypeOfSymbol(exported)
            : checker.getTypeOfSymbolAtLocation(exported, exported.valueDeclaration ?? file),
          exported.name,
        );
      }
  }
  try {
    sqlCheck(root, collect(root));
  } catch (error) {
    const message = String(error.message);
    const rule = message.startsWith("schema:")
      ? "schema"
      : message.startsWith("sql-static:")
        ? "sql-static"
        : "sql-ownership";
    report(rule, message);
  }
  if (freshness && !errors.length) {
    const file = path.join(root, "platform/generated/catalogs.ts");
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== generated(root))
      report("capability", "named-query manifest/build hash is stale; run pnpm generate");
  }
  return onlyRule
    ? errors.filter(
        (error) =>
          error.rule === onlyRule || (onlyRule === "schema" && error.rule.startsWith("sql-")),
      )
    : errors;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rule = process.argv.includes("--rule")
    ? process.argv[process.argv.indexOf("--rule") + 1]
    : undefined;
  const errors = check(process.cwd(), rule);
  for (const error of errors) console.error(`${error.rule}: ${error.message}`);
  if (errors.length) process.exitCode = 1;
  else console.log(`Boundary checks passed${rule ? ` (${rule})` : ""}`);
}
