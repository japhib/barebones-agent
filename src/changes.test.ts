import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { changeStat, describeChange, paintChange } from "./changes.js";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";

/** The painted body with the label line and all colour stripped, for asserting on
 *  structure rather than escape codes. */
function body(label: string, before: string, after: string, maxLines?: number): string[] {
  const painted = paintChange(label, describeChange(before, after), maxLines);
  // eslint-disable-next-line no-control-regex
  return painted.split("\n").slice(1).map((l) => l.replace(/\x1b\[\d+m/g, "").trim());
}

describe("describeChange", () => {
  test("takes the removed and added lines straight from the two spans", () => {
    const c = describeChange("old one\nold two", "new one");
    assert.deepEqual(c.removed, ["old one", "old two"]);
    assert.deepEqual(c.added, ["new one"]);
  });

  test("an empty side means nothing was removed, or nothing added", () => {
    assert.deepEqual(describeChange("", "fresh"), { removed: [], added: ["fresh"] });
    assert.deepEqual(describeChange("gone", ""), { removed: ["gone"], added: [] });
    assert.deepEqual(describeChange("", ""), { removed: [], added: [] });
  });

  test("a trailing newline is a boundary, not a blank line of its own", () => {
    // "foo\n" is one line plus a terminator; showing a second, empty + row would read
    // as content that is not there.
    assert.deepEqual(describeChange("", "foo\n").added, ["foo"]);
    assert.deepEqual(describeChange("", "foo\n\n").added, ["foo", ""]);
  });

  test("identical text is no change at all, not every line swapped for itself", () => {
    // With no diff algorithm to notice, this is the one case that has to be caught by
    // hand: write_file rewriting a file with exactly its own contents.
    assert.deepEqual(describeChange("same\nlines\n", "same\nlines\n"), { removed: [], added: [] });
    assert.equal(changeStat(describeChange("x", "x")), "+0 -0");
  });

  test("keeps a partial line intact, since a span need not be whole lines", () => {
    // edit_file replacing a word inside a line: the span is "hello", not the line.
    assert.deepEqual(describeChange("hello", "goodbye"), { removed: ["hello"], added: ["goodbye"] });
  });
});

describe("changeStat", () => {
  test("counts both sides", () => {
    assert.equal(changeStat(describeChange("a\nb", "x")), "+1 -2");
    assert.equal(changeStat(describeChange("", "a\nb\nc")), "+3 -0");
    assert.equal(changeStat(describeChange("", "")), "+0 -0");
  });

  test("reports true totals even when the display is capped", () => {
    const c = describeChange("", "x\n".repeat(500));
    assert.equal(changeStat(c), "+500 -0");
    // The cap belongs to the painter, so it cannot change what the stat reports.
    assert.match(paintChange("write_file big.ts", c, 10), /\+500/);
  });
});

describe("paintChange", () => {
  test("removals in red above additions in green", () => {
    const out = paintChange("edit_file a.ts:4", describeChange("two", "TWO"));
    assert.ok(out.includes(`${RED}-two`), "the old text, in red");
    assert.ok(out.includes(`${GREEN}+TWO`), "the new text, in green");
    assert.ok(out.includes("edit_file a.ts:4"), "the label names the file and line");
    assert.ok(out.includes(`${GREEN}+1`) && out.includes(`${RED}-1`), "and carries the stat");
    // Removals come first, so the block reads as a replacement.
    assert.ok(out.indexOf(`${RED}-two`) < out.indexOf(`${GREEN}+TWO`));
  });

  test("multi-line spans are shown one prefixed line each", () => {
    assert.deepEqual(body("edit_file a.ts:1", "a\nb", "x\ny\nz"), ["-a", "-b", "+x", "+y", "+z"]);
  });

  test("a creation is all additions, with no red at all", () => {
    assert.deepEqual(body("write_file new.ts (new file)", "", "one\ntwo\n"), ["+one", "+two"]);
  });

  test("every painted line closes its colour, so it cannot bleed into later output", () => {
    const out = paintChange("write_file a.ts", describeChange("a", "b"));
    for (const line of out.split("\n")) {
      if (line.includes("\x1b[")) assert.ok(line.endsWith("\x1b[0m"), `unterminated: ${JSON.stringify(line)}`);
    }
  });

  test("says so plainly when nothing changed, rather than printing an empty block", () => {
    const out = paintChange("write_file a.ts", describeChange("", ""));
    assert.match(out, /\(no change\)/);
    assert.ok(!out.includes("+0"), "a no-op should not advertise a stat");
  });

  describe("the display cap", () => {
    test("holds back the overflow and says how much", () => {
      const shown = body("write_file big.ts", "", "x\n".repeat(500), 10);
      assert.equal(shown.length, 11); // 10 lines plus the footer
      assert.equal(shown.at(-1), "… 490 more lines not shown");
    });

    test("trims removals before additions, since the new text matters more", () => {
      // 6 removed + 2 added, capped at 4: both additions survive, removals give way.
      const shown = body("write_file a.ts", "r1\nr2\nr3\nr4\nr5\nr6", "a1\na2", 4);
      assert.deepEqual(shown, ["-r1", "-r2", "+a1", "+a2", "… 4 more lines not shown"]);
    });

    test("trims additions too once every removal is gone", () => {
      const shown = body("write_file a.ts", "r1\nr2", "a1\na2\na3", 2);
      assert.deepEqual(shown, ["+a1", "+a2", "… 3 more lines not shown"]);
    });

    test("leaves a change that fits completely alone", () => {
      assert.deepEqual(body("edit_file a.ts:1", "a", "b", 200), ["-a", "+b"]);
    });
  });
});
