// Extracts the public plugin API surface from the official `obsidian.d.ts`
// typings (npm package `obsidian`, MIT). Only names and member kinds are
// kept: the survey checks which of them Basalt provides at runtime.
import ts from "typescript";

/**
 * @typedef {{ name: string, kind: "method" | "property", static: boolean }} Member
 * @typedef {{ name: string, kind: "class" | "interface", extends: string[], members: Member[] }} TypeEntry
 * @typedef {{ exports: { name: string, kind: string }[], types: Record<string, TypeEntry>, globals: Record<string, Member[]> }} ApiSurface
 */

/** @returns {ApiSurface} */
export function extractApiSurface(source) {
  const file = ts.createSourceFile(
    "obsidian.d.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  /** @type {ApiSurface} */
  const surface = { exports: [], types: {}, globals: {} };
  const exported = (node) =>
    node.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ?? false;
  const memberName = (member) => {
    const name = member.name;
    if (!name) return null;
    if (
      ts.isIdentifier(name) ||
      ts.isStringLiteral(name) ||
      ts.isPrivateIdentifier(name)
    )
      return name.text;
    return null;
  };
  const membersOf = (node) => {
    /** @type {Member[]} */
    const members = [];
    const seen = new Set();
    for (const member of node.members) {
      const name = memberName(member);
      if (!name || name.startsWith("#")) continue;
      const isStatic =
        member.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
        ) ?? false;
      const kind =
        ts.isMethodDeclaration(member) || ts.isMethodSignature(member)
          ? "method"
          : ts.isPropertyDeclaration(member) ||
              ts.isPropertySignature(member) ||
              ts.isGetAccessor(member) ||
              ts.isSetAccessor(member)
            ? // A property typed as a function is still called like a method.
              member.type && ts.isFunctionTypeNode(member.type)
              ? "method"
              : "property"
            : null;
      if (!kind) continue;
      const key = `${isStatic}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      members.push({ name, kind, static: isStatic });
    }
    return members;
  };
  const heritage = (node) =>
    (node.heritageClauses ?? []).flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(file)),
    );

  for (const statement of file.statements) {
    if (
      ts.isModuleDeclaration(statement) &&
      statement.name.getText(file) === "global"
    ) {
      for (const inner of statement.body?.statements ?? []) {
        if (ts.isInterfaceDeclaration(inner)) {
          const list = (surface.globals[inner.name.text] ??= []);
          for (const member of membersOf(inner))
            if (!list.some((known) => known.name === member.name))
              list.push(member);
        } else if (ts.isFunctionDeclaration(inner) && inner.name) {
          (surface.globals.window ??= []).push({
            name: inner.name.text,
            kind: "method",
            static: false,
          });
        } else if (ts.isVariableStatement(inner)) {
          for (const declaration of inner.declarationList.declarations)
            if (ts.isIdentifier(declaration.name))
              (surface.globals.window ??= []).push({
                name: declaration.name.text,
                kind: "property",
                static: false,
              });
        }
      }
      continue;
    }
    if (!exported(statement)) continue;
    if (ts.isClassDeclaration(statement) && statement.name) {
      surface.exports.push({ name: statement.name.text, kind: "class" });
      surface.types[statement.name.text] = {
        name: statement.name.text,
        kind: "class",
        extends: heritage(statement),
        members: membersOf(statement),
      };
    } else if (ts.isInterfaceDeclaration(statement)) {
      surface.types[statement.name.text] = {
        name: statement.name.text,
        kind: "interface",
        extends: heritage(statement),
        members: membersOf(statement),
      };
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      if (!surface.exports.some((entry) => entry.name === statement.name.text))
        surface.exports.push({ name: statement.name.text, kind: "function" });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name))
          surface.exports.push({ name: declaration.name.text, kind: "const" });
    } else if (ts.isEnumDeclaration(statement)) {
      surface.exports.push({ name: statement.name.text, kind: "enum" });
    }
  }
  return surface;
}

/** Members of a type including everything it inherits from other API types. */
export function flattenMembers(surface, name, seen = new Set()) {
  const entry = surface.types[name];
  if (!entry || seen.has(name)) return [];
  seen.add(name);
  const members = new Map(
    entry.members.map((member) => [
      `${member.static}:${member.name}`,
      { ...member, owner: name },
    ]),
  );
  for (const parent of entry.extends) {
    for (const member of flattenMembers(
      surface,
      parent.replace(/<.*$/, ""),
      seen,
    )) {
      const key = `${member.static}:${member.name}`;
      if (!members.has(key)) members.set(key, member);
    }
  }
  return [...members.values()];
}
