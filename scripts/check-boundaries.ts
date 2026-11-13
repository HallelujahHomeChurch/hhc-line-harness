import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
const dependencies = Object.keys(
  JSON.parse(readFileSync("package.json", "utf8")).dependencies,
) as string[];
function allowed(file: string, spec: string) {
  if (spec.startsWith(".") || spec.startsWith("node:")) return true;
  const pkg = spec.startsWith("@")
    ? spec.split("/").slice(0, 2).join("/")
    : spec.split("/")[0]!;
  if (!dependencies.includes(pkg)) return false;
  if (pkg.startsWith("@azure/") || pkg === "openai")
    return file.startsWith("src/providers/") || file.startsWith("src/agent/");
  if (pkg === "@openai/agents") return file.startsWith("src/agent/");
  if (["pdfjs-dist", "fflate", "fast-xml-parser"].includes(pkg))
    return file.startsWith("src/extraction/");
  return true;
}
assert.equal(allowed("src/domain/example.ts", "openai"), false);
assert.equal(allowed("src/providers/example.ts", "openai"), true);
assert.equal(allowed("src/agent/example.ts", "@openai/agents"), true);
assert.equal(
  allowed("src/extraction/example.ts", "pdfjs-dist/legacy/build/pdf.mjs"),
  true,
);
assert.equal(allowed("src/domain/example.ts", "legacy-bot"), false);
for (const path of readdirSync("src", { recursive: true }).filter(
  (p) => typeof p === "string" && p.endsWith(".ts"),
)) {
  const file = "src/" + path,
    ast = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
  const visit = (node: ts.Node) => {
    let spec: ts.Expression | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      spec = node.moduleSpecifier;
    else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    )
      spec = node.arguments[0];
    if (spec)
      assert.ok(
        ts.isStringLiteral(spec) && allowed(file, spec.text),
        `dependency boundary: ${file}`,
      );
    ts.forEachChild(node, visit);
  };
  visit(ast);
}
process.stdout.write(
  "Declared dependencies and SDK/extraction import boundaries passed\n",
);
