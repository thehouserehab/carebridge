import assert from "node:assert/strict";
import { test } from "node:test";
import { assessmentRow, reindexAssessmentRows } from "../src/record-ui.js";

const keys = ["tool", "item", "value", "unit", "context"];
function row(index) {
  const legend = { textContent: `측정값 ${index + 1}` };
  const controls = keys.map((key) => ({ name: `assessment-${index}-${key}` }));
  // Renumbering must neither read nor assign values (not even ""), or a
  // browser's partially typed number could be normalized/lost.
  for (const input of controls) Object.defineProperty(input, "value", {
    get() { assert.fail("Renumbering must not read input values"); },
    set() { assert.fail("Renumbering must not write input values"); },
  });
  return { legend, controls, querySelector(selector) {
    if (selector === "legend") return legend;
    const key = keys.find((key) => selector === `[name$="-${key}"]`);
    assert.ok(key, `Unexpected row selector ${selector}`);
    return controls.find((input) => input.name.endsWith(`-${key}`));
  } };
}
function group(rows) {
  return { querySelectorAll(selector) {
    assert.equal(selector, "[data-assessment]"); return rows;
  } };
}
function expectPositions(rows) {
  assert.deepEqual(rows.map((entry) => entry.legend.textContent), rows.map((_, index) => `측정값 ${index + 1}`));
  assert.deepEqual(rows.flatMap((entry) => entry.controls.map((input) => input.name)),
    rows.flatMap((_, index) => keys.map((key) => `assessment-${index}-${key}`)));
}

test("assessment removal renumbers first/middle/last gaps without replacing controls or reading their values", () => {
  for (const removed of [0, 1, 2]) {
    const rows = [row(0), row(1), row(2)];
    rows.splice(removed, 1);
    const originalControls = rows.map((entry) => [...entry.controls]);
    reindexAssessmentRows(group(rows)); expectPositions(rows);
    rows.forEach((entry, index) => entry.controls.forEach((input, offset) => assert.equal(input, originalControls[index][offset])));
  }
});

test("a row appended after a reopened record's removal has unique names and sequential legends", () => {
  const rows = [row(1), row(2), row(2)]; // old remove-then-add collision
  reindexAssessmentRows(group(rows)); expectPositions(rows);
  const first = rows.map((entry) => [...entry.controls]);
  reindexAssessmentRows(group(rows)); expectPositions(rows);
  rows.forEach((entry, index) => entry.controls.forEach((input, offset) => assert.equal(input, first[index][offset])));
});

test("repeated row deletion and addition preserve ordered form positions up to the existing twenty-row limit", () => {
  const rows = Array.from({ length: 20 }, (_, index) => row(index));
  reindexAssessmentRows(group(rows)); expectPositions(rows);
  while (rows.length) {
    rows.splice(Math.floor(rows.length / 2), 1);
    reindexAssessmentRows(group(rows)); expectPositions(rows);
  }
  rows.push(row(0)); reindexAssessmentRows(group(rows)); expectPositions(rows);
});

test("generated measurement controls distinguish a new blank value from explicitly entered zero", () => {
  for (const [value, expected] of [[undefined, ""], [null, ""], [0, "0"]]) {
    const html = assessmentRow({ value }, 2);
    assert.match(html, /<legend>측정값 3<\/legend>/);
    assert.ok(html.includes(`name="assessment-2-value" type="number" value="${expected}"`));
    assert.equal((html.match(/name="assessment-2-/g) || []).length, 5);
  }
});
