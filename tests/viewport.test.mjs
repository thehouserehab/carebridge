import test from "node:test";
import assert from "node:assert/strict";
import { observeViewport } from "../src/viewport.js";

function withViewport(visualHeight, run) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const properties = new Map();
  const attributes = new Set();
  const events = new Map();
  const visualEvents = new Map();
  globalThis.document = {
    documentElement: {
      style: { setProperty: (key, value) => properties.set(key, value) },
      toggleAttribute: (key, enabled) => enabled ? attributes.add(key) : attributes.delete(key),
    },
  };
  globalThis.window = {
    innerHeight: 844,
    visualViewport: visualHeight === undefined ? undefined : {
      height: visualHeight,
      addEventListener: (name, listener) => visualEvents.set(name, listener),
    },
    addEventListener: (name, listener) => events.set(name, listener),
  };
  try {
    observeViewport();
    run({ properties, attributes, events, visualEvents });
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

test("대화의 축약 상태는 키보드로 줄어든 visualViewport 높이를 따라가고 복원된다", () => {
  withViewport(844, ({ properties, attributes, visualEvents }) => {
    assert.equal(properties.get("--visible-height"), "844px");
    assert.equal(attributes.has("data-compact-viewport"), false);
    window.visualViewport.height = 420.4;
    visualEvents.get("resize")();
    assert.equal(window.innerHeight, 844);
    assert.equal(properties.get("--visible-height"), "420px");
    assert.equal(attributes.has("data-compact-viewport"), true);
    window.visualViewport.height = 844;
    visualEvents.get("resize")();
    assert.equal(attributes.has("data-compact-viewport"), false);
  });
});

test("visualViewport를 지원하지 않는 브라우저는 창 높이와 resize를 사용한다", () => {
  withViewport(undefined, ({ properties, attributes, events }) => {
    assert.equal(properties.get("--visible-height"), "844px");
    window.innerHeight = 500;
    events.get("resize")();
    assert.equal(properties.get("--visible-height"), "500px");
    assert.equal(attributes.has("data-compact-viewport"), true);
    window.innerHeight = 501;
    events.get("resize")();
    assert.equal(attributes.has("data-compact-viewport"), false);
  });
});
