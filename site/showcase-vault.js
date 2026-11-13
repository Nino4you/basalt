// Showcase vault of the project page. The landing page seeds the browser demo
// with it (once, and only if the visitor has no demo data yet), and
// tools/site_screenshots.mjs uses the same notes for the screenshots.

/** Accent colour used in the screenshots; a regular Basalt setting. */
export const accent = "#4fb286";

/**
 * Saved workspace of the demo vault, so a first visit starts on the welcome
 * note. An unreadable workspace only makes the demo open its first note.
 */
export const workspace = {
  key: 'basalt-workspace:"basalt-demo-v1"',
  value: { tabs: [{ path: "Welcome.md" }], active: 0 },
};

const canvas = {
  nodes: [
    {
      id: "g1",
      type: "group",
      x: -520,
      y: -300,
      width: 1080,
      height: 640,
      label: "Iceland 2027",
    },
    {
      id: "n1",
      type: "text",
      x: -480,
      y: -250,
      width: 300,
      height: 190,
      color: "4",
      text: "## South coast\n\nTwo days between Vík and Skaftafell. Columns first, glaciers second.",
    },
    {
      id: "n2",
      type: "file",
      x: -120,
      y: -250,
      width: 380,
      height: 330,
      file: "Places/Svartifoss.md",
    },
    {
      id: "n3",
      type: "text",
      x: -480,
      y: 20,
      width: 300,
      height: 150,
      color: "5",
      text: "**Open questions**\n\n- Ferry to Staffa in May?\n- Rent crampons or bring them?",
    },
    {
      id: "n4",
      type: "file",
      x: 320,
      y: -250,
      width: 200,
      height: 150,
      file: "Trips/Packing list.md",
    },
    {
      id: "n5",
      type: "text",
      x: 320,
      y: -40,
      width: 200,
      height: 120,
      color: "6",
      text: "Low tide at Reynisfjara: check the evening before.",
    },
    {
      id: "n6",
      type: "file",
      x: -120,
      y: 130,
      width: 640,
      height: 170,
      file: "Columnar jointing.md",
    },
  ],
  edges: [
    {
      id: "e1",
      fromNode: "n1",
      fromSide: "right",
      toNode: "n2",
      toSide: "left",
    },
    {
      id: "e2",
      fromNode: "n2",
      fromSide: "right",
      toNode: "n4",
      toSide: "left",
    },
    {
      id: "e3",
      fromNode: "n3",
      fromSide: "right",
      toNode: "n6",
      toSide: "left",
    },
    {
      id: "e4",
      fromNode: "n2",
      fromSide: "bottom",
      toNode: "n6",
      toSide: "top",
    },
  ],
};

export const vault = {
  "Welcome.md": `A quiet place for everything I learn about rocks, routes and the trips in between.

## Where to start

- [x] Write down why [[Columnar jointing]] makes hexagons
- [x] Sketch the route for [[Iceland 2027]]
- [ ] Sort the photos from [[Svartifoss]]
- [ ] Finish the [[Packing list]]

> Notes are plain Markdown files in a folder. No account, no cloud.

## Hexagons, briefly

A regular hexagon with side $s$ covers $A = \\frac{3\\sqrt{3}}{2}s^2$, and no other tiling divides a plane into equal areas with less edge.

| Place | Where | Seen |
| --- | --- | --- |
| [[Svartifoss]] | Skaftafell, Iceland | yes |
| [[Reynisfjara]] | Vík, Iceland | yes |
| [[Staffa]] | Inner Hebrides, Scotland | planned |

#home
`,
  "Columnar jointing.md": `# Columnar jointing

When a thick lava flow cools, it contracts. The stress is released by cracks that grow inwards from the cooling surfaces and split the rock into long, polygonal columns, most of them six-sided.

- Slow cooling tends to give wide, regular columns.
- Fast cooling gives narrow, irregular ones.
- The pattern is the same one mud makes when it dries, only in three dimensions.

Seen at [[Svartifoss]], [[Reynisfjara]] and [[Staffa]]. Back to [[Welcome]].

#geology
`,
  "Places/Svartifoss.md": `# Svartifoss

A waterfall in Skaftafell, framed by dark hanging basalt columns. A textbook example of [[Columnar jointing]] and the reason this vault exists.

- Short hike from the Skaftafell visitor centre
- Best light in the late afternoon
- Part of [[Iceland 2027]]; see also [[Welcome]]

#geology #iceland
`,
  "Places/Reynisfjara.md": `# Reynisfjara

Black sand beach near Vík with a cliff of basalt columns and a cave at its foot. Another face of [[Columnar jointing]].

> [!warning] Sneaker waves
> Keep well away from the waterline, even on calm days.

Stop on the [[Iceland 2027]] route.

#geology #iceland
`,
  "Places/Staffa.md": `# Staffa

Small island in the Inner Hebrides, known for Fingal's Cave and its walls of basalt columns. Same [[Columnar jointing]], different ocean.

Not on the [[Iceland 2027]] route; a trip of its own.

#geology #scotland
`,
  "Trips/Iceland 2027.md": `# Iceland 2027

Rough plan for a week along the south coast.

1. Reykjavík, pick up the car
2. Vík and [[Reynisfjara]]
3. Skaftafell and [[Svartifoss]]
4. Back along the coast, slowly

Everything to bring is on the [[Packing list]]; the board is in [[Trip board.canvas]].

#trip #iceland
`,
  "Trips/Packing list.md": `# Packing list

- [x] Rain shell
- [x] Hiking boots
- [ ] Spare camera battery
- [ ] Notebook, the paper kind
- [ ] Offline maps

For [[Iceland 2027]].

#trip
`,
  "Journal/2026-11-12.md": `# 2026-11-12

Read about why cooling lava cracks into hexagons and wrote it up in [[Columnar jointing]]. Started the [[Packing list]]. The [[Welcome]] note finally has a table.

#journal
`,
  "Trip board.canvas": JSON.stringify(canvas, null, "\t"),
};
