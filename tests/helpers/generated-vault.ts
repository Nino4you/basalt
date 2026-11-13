/**
 * Deterministic synthetic vaults for graph and index measurements: notes in
 * folders, linked mostly within topic clusters, with hubs, cross links, tags,
 * unresolved links and a share of unlinked notes. The same `count` and `seed`
 * always give the same files.
 */
export interface GeneratedVaultOptions {
  count: number;
  seed?: number;
  /** Notes per topic cluster. */
  clusterSize?: number;
  /** Share of notes without any link. */
  orphans?: number;
}

function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

export function generateVault(
  options: GeneratedVaultOptions,
): Record<string, string> {
  const { count, seed = 7, clusterSize = 40, orphans = 0.08 } = options;
  const next = random(seed);
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(next() * list.length)];
  const clusters = Math.max(1, Math.ceil(count / clusterSize));
  const paths: string[] = [];
  const clusterOf: number[] = [];
  for (let i = 0; i < count; i++) {
    const cluster = i % clusters;
    clusterOf.push(cluster);
    paths.push(`Thema ${cluster}/Notiz ${i}.md`);
  }
  const members: number[][] = Array.from({ length: clusters }, () => []);
  paths.forEach((_, i) => members[clusterOf[i]].push(i));
  const name = (i: number) => `Notiz ${i}`;
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const lines = [`# ${name(i)}`, ""];
    if (next() < orphans) {
      lines.push("Eine Notiz ohne Links.");
      files[paths[i]] = lines.join("\n");
      continue;
    }
    const own = members[clusterOf[i]];
    // The first member of every cluster is its hub.
    const links = new Set<number>([own[0]]);
    const local = 1 + Math.floor(next() * 5);
    for (let k = 0; k < local; k++) links.add(pick(own));
    if (next() < 0.25) links.add(Math.floor(next() * count));
    links.delete(i);
    for (const target of links)
      lines.push(`Siehe [[${name(target)}]] für Details.`);
    if (next() < 0.1) lines.push(`Noch offen: [[Entwurf ${i % 50}]]`);
    lines.push("", `#thema${clusterOf[i] % 30}`);
    if (next() < 0.2) lines.push("#offen");
    files[paths[i]] = lines.join("\n");
  }
  return files;
}
