# Bases

A base (`.base` file) shows the notes of a vault as a table or as cards. It is a YAML file in
the same format as Obsidian Bases, so bases written in either app open in the other. Basalt
implements the format from the public Bases documentation; anything listed under
"Not supported yet" is shown as an error or ignored instead of being guessed.

Create one with **Create new base** in the command palette or **New base** in the file
explorer's context menu. The `</>` button at the top right switches to the YAML source;
clicking a column header sorts by that column (ascending, descending, off) and writes only the
view's `sort` entry back into the file.

## Example

```yaml
filters:
  and:
    - file.inFolder("Books")
    - file.hasTag("book")
formulas:
  stars: 'if(rating, "★".repeat(rating), "")'
  age: 'today().year - year'
properties:
  formula.stars:
    displayName: Rating
views:
  - type: table
    name: All books
    order: [file.name, author, year, formula.age, formula.stars]
    sort:
      - property: year
        direction: ASC
  - type: table
    name: By status
    groupBy:
      property: status
      direction: ASC
  - type: cards
    name: Shelf
    image: cover
    limit: 50
```

## Supported

- **Top level:** `filters`, `formulas`, `properties` (`displayName`), `views`.
- **Filters:** expression strings and nested `and` / `or` / `not` lists, globally and per
  view (both apply).
- **Views:** `type` (`table` or `cards`; other types render as a table), `name`, `filters`,
  `order`, `sort` (`property` + `direction`), `groupBy`, `limit`, `image` (cards: a vault
  image, a link to one, or a colour such as `#8a5cf5`). Without `order` the table shows the file
  name and the properties the results use.
- **Expressions:** `+ - * / %`, comparisons, `&& || !`, parentheses, lists `[…]`, indexing,
  string, number, boolean and regex literals; `note.x`, bare `x`, `note["with space"]`,
  `file.*`, `formula.*`, `this`.
- **File fields:** `name`, `basename`, `path`, `folder`, `ext`, `size`, `ctime`, `mtime`
  (native app only), `tags`, `links`, `embeds`, `backlinks`, `properties`.
- **Functions:** `if`, `date`, `duration`, `now`, `today`, `number`, `list`, `link`, `file`,
  `min`, `max`, `random`; file `hasTag`, `inFolder`, `hasProperty`, `hasLink`, `asLink`;
  string `contains(All/Any)`, `startsWith`, `endsWith`, `lower`, `upper`, `title`, `trim`,
  `replace`, `repeat`, `reverse`, `slice`, `split`, `length`; number `abs`, `ceil`, `floor`,
  `round`, `toFixed`; list `contains(All/Any)`, `filter`, `map`, `reduce`, `join`, `sort`,
  `unique`, `flat`, `reverse`, `slice`, `length`; date fields, `format`, `date`, `time`,
  `relative`; link `asFile`, `linksTo`; object `keys`, `values`; regex `matches`; any value
  `isEmpty`, `isTruthy`, `isType`, `toString`.
- **Dates:** `YYYY-MM-DD` and `YYYY-MM-DD HH:mm(:ss)` properties are dates; `date + "1 week"`,
  `now() - "2h"`, `"1M"` (month) vs `"1m"` (minute); the difference of two dates is a duration
  (`.days`, `.hours`, …).

## Not supported yet

- Embedding a base in a note (`![[x.base]]` or a ` ```base ` code block).
- `summaries`, `groupOrder`, list, kanban and map views, and editing property values from the
  table.
- `html()`, `image()` and `icon()` render as plain text.
