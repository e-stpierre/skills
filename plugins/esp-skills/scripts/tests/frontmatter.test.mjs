import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseFrontmatter } from "../lib/frontmatter.mjs";

describe("parseFrontmatter", () => {
  test("parses flat scalars", () => {
    assert.deepEqual(parseFrontmatter("---\ntitle: x\ncount: 2\n---\nbody\n"), {
      title: "x",
      count: 2
    });
  });

  test("accepts a leading byte-order mark", () => {
    assert.deepEqual(parseFrontmatter("﻿---\ntitle: x\n---\n"), {
      title: "x"
    });
  });

  test("returns null without frontmatter", () => {
    assert.equal(parseFrontmatter("# Title\n"), null);
  });
});
