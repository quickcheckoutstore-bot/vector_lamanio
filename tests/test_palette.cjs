const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const PaletteColors = require("../frontend/palette.js");

test("Grand Canyon reference produces six paint circles including all edge shades", () => {
  const histogram = new Map(
    JSON.parse(
      require("node:zlib").gunzipSync(
        fs.readFileSync(__dirname + "/fixtures/canyon-colors.json.gz"),
      ),
    ),
  );
  const paints = PaletteColors.anchors(histogram);
  const expected = [
    "#b4362e",
    "#772c2a",
    "#f88720",
    "#ffffff",
    "#da5f2b",
    "#eca124",
  ];
  assert.deepEqual(
    paints.map((p) => p.color),
    expected,
  );
  const groups = PaletteColors.paintGroups(histogram, paints);
  assert.deepEqual(
    groups.map((g) => g.main.color),
    expected,
  );
  assert.equal(new Set(groups.flatMap((g) => g.colors)).size, histogram.size);
  for (const g of groups) {
    const compact = PaletteColors.swatches(g);
    assert.ok(compact.length <= 3);
    assert.deepEqual(
      compact.flatMap((s) => s.colors).sort(),
      [...g.colors].sort(),
    );
    assert.equal(PaletteColors.swatches(g, true).length, g.colors.length);
  }
  const traced = new Map(
    JSON.parse(
      require("node:zlib").gunzipSync(
        fs.readFileSync(__dirname + "/fixtures/canyon-traced.json.gz"),
      ),
    ),
  );
  const reduced = new Map(
    PaletteColors.group(traced, 0.018).map((g) => [g.main.color, g.count]),
  );
  const tracedGroups = PaletteColors.paintGroups(reduced, paints);
  assert.equal(tracedGroups.length, 6);
  tracedGroups.forEach((g, i) =>
    assert.ok(PaletteColors.distance(g.main.lab, paints[i].lab) < 0.04),
  );
});

test("paint anchors keep close colors at their nearest paint and retain new unrelated fills", () => {
  const paints = PaletteColors.anchors(
    new Map([
      ["#b4362e", 500],
      ["#772c2a", 300],
      ["#f88720", 100],
      ["#da5f2b", 100],
    ]),
  );
  const colors = new Map([
    ["#b4362e", 1],
    ["#b5362e", 100],
    ["#772c2a", 1],
    ["#f88720", 1],
    ["#da5f2b", 1],
    ["#00ff00", 1],
  ]);
  const groups = PaletteColors.paintGroups(colors, paints);
  assert.deepEqual(
    groups.find((g) => g.colors.includes("#b4362e")).colors.sort(),
    ["#b4362e", "#b5362e"],
  );
  assert.deepEqual(groups.find((g) => g.colors.includes("#00ff00")).colors, [
    "#00ff00",
  ]);
  colors.delete("#772c2a");
  assert.equal(PaletteColors.paintGroups(colors, paints).length, 4);
});

test("nearby shades share a group while unrelated hues stay separate", () => {
  const groups = PaletteColors.group(
    new Map([
      ["#123c80", 10],
      ["#164188", 2],
      ["#ff4545", 7],
      ["#ff5050", 3],
      ["#fff4df", 1],
    ]),
  );
  assert.equal(groups.length, 3);
  const blues = groups.find((g) => g.colors.includes("#123c80"));
  assert.deepEqual(blues.colors, ["#123c80", "#164188"]);
  assert.equal(blues.main.color, "#123c80");
  assert.equal(blues.count, 12);
});

test("all colors remain represented and groups have bounded perceptual diameter", () => {
  const colors = new Map(
    Array.from({ length: 256 }, (_, n) => [
      `#${n.toString(16).padStart(2, "0").repeat(3)}`,
      1,
    ]),
  );
  const groups = PaletteColors.group(colors);
  assert.equal(groups.flatMap((g) => g.colors).length, 256);
  for (const group of groups) {
    for (const a of group.entries)
      for (const b of group.entries)
        assert.ok(PaletteColors.distance(a.lab, b.lab) <= 0.12 + 1e-10);
    assert.deepEqual(
      group.entries.map((e) => e.lab[0]),
      group.entries.map((e) => e.lab[0]).sort((a, b) => a - b),
    );
  }
  assert.deepEqual(PaletteColors.group(new Map()), []);
  assert.deepEqual(groups, PaletteColors.group(new Map([...colors].reverse())));
});

function editor() {
  // Exercise the actual editor mutations with minimal DOM stand-ins.
  const elements = new Map();
  const events = new Map();
  const node = () => ({
    value: "",
    disabled: false,
    dataset: {},
    style: {},
    children: [],
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {},
    addEventListener(type, handler) {
      (this.events ||= {})[type] = handler;
    },
    append(...items) {
      this.children.push(...items);
    },
    remove() {},
    replaceChildren(...items) {
      this.children = items;
    },
    querySelectorAll() {
      return [];
    },
  });
  const context = vm.createContext({
    PaletteColors,
    console,
    setTimeout,
    clearTimeout,
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, node());
        return elements.get(id);
      },
      createElement: node,
      body: node(),
      elementFromPoint: () => context.hit,
      addEventListener(type, handler) {
        events.set(type, handler);
      },
    },
    window: { addEventListener() {} },
  });
  const source = fs.readFileSync(require.resolve("../frontend/app.js"), "utf8");
  vm.runInContext(
    source.slice(0, source.indexOf("function pickBackground")),
    context,
  );
  vm.runInContext(
    `
    state.svg = {};
    state.job = {status: 'ready'};
    function path(id, color, removed = false) {
      return {id, getAttribute: () => state.edits.fills[id] || color,
        classList: {contains: () => removed || state.edits.deleted.includes(id)}};
    }
    state.paths = [path('a', '#123c80'), path('b', '#164188'), path('c', '#ff4545'),
      path('d', '#ff5050'), path('e', '#123c80', true), path('f', '#ffffff')];
    apply = () => {};
    scheduleSave = () => {};
    selection = () => {};
    toast = () => {};
    globalThis.editorState = state;
    state.paletteGroups = PaletteColors.group(new Map(state.paths.filter(p => !p.classList.contains('removed')).map(p => [p.getAttribute('fill'), 1])));
  `,
    context,
  );
  context.events = events;
  context.elements = elements;
  return context;
}

test("group merge affects both groups, skips deleted shapes, and undo/redo restore edits", () => {
  const c = editor();
  vm.runInContext(
    `mergePalette(['#123c80', '#164188'], ['#ff4545', '#ff5050'], '#ff4545')`,
    c,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(c.editorState.edits.fills)), {
    a: "#ff4545",
    b: "#ff4545",
    c: "#ff4545",
    d: "#ff4545",
  });
  assert.equal(c.editorState.undo.length, 1);
  vm.runInContext("history()", c);
  assert.equal(Object.keys(c.editorState.edits.fills).length, 0);
  vm.runInContext("history(true)", c);
  assert.equal(Object.keys(c.editorState.edits.fills).length, 4);
});

test("swatch merge affects only two colors and exact removal uses current fills", () => {
  const c = editor();
  vm.runInContext(
    `mergePalette(['#123c80'], ['#ff4545'], '#ff4545');
    remove(palettePaths(['#ff4545']).map(p => p.id));`,
    c,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(c.editorState.edits.fills)), {
    a: "#ff4545",
    c: "#ff4545",
  });
  assert.deepEqual(Array.from(c.editorState.edits.deleted), ["a", "c"]);
  assert.equal(c.editorState.undo.length, 2);
  vm.runInContext("history()", c);
  assert.equal(c.editorState.edits.deleted.length, 0);
  vm.runInContext(`mergePalette(['#ff4545'], ['#ff4545'], '#ff4545')`, c);
  assert.equal(c.editorState.undo.length, 1);
});

test("touch group drag joins circles while preserving every shade", () => {
  const c = editor();
  const card = (colors, color) => ({
    dataset: { colors: JSON.stringify(colors), color },
    matches: () => false,
    classList: { add() {}, remove() {} },
  });
  const source = card(["#123c80", "#164188"], "#123c80");
  const target = card(["#ff4545", "#ff5050"], "#ff4545");
  const handle = {
    matches: () => false,
    closest: () => source,
    setPointerCapture() {},
  };
  c.elements.get("palette").contains = () => true;
  c.hit = {
    closest(selector) {
      assert.equal(selector, ".palette-group");
      return target;
    },
  };
  const event = {
    button: 0,
    pointerId: 1,
    pointerType: "touch",
    clientX: 10,
    clientY: 10,
    target: { closest: () => handle },
    preventDefault() {},
  };
  c.elements.get("palette").events.pointerdown(event);
  c.events.get("pointermove")({ ...event, clientX: 50, clientY: 50 });
  c.events.get("pointerup")({ ...event, clientX: 50, clientY: 50 });
  assert.equal(Object.keys(c.editorState.edits.fills).length, 0);
  assert.ok(c.editorState.edits.palette_groups.some((g) => g.length === 4));
  assert.equal(c.editorState.undo.length, 1);
});

test("a shade can move between circles and split out without changing artwork", () => {
  const c = editor();
  vm.runInContext(
    `movePalette(['#164188'], ['#ff4545', '#ff5050']);
    state.paletteGroups = PaletteColors.regroup(new Map(state.paths.filter(p => !p.classList.contains('removed')).map(p => [p.getAttribute('fill'), 1])), state.edits.palette_groups);
    splitPalette(['#164188']);`,
    c,
  );
  assert.equal(Object.keys(c.editorState.edits.fills).length, 0);
  assert.ok(
    c.editorState.edits.palette_groups.some(
      (g) => g.length === 1 && g[0] === "#164188",
    ),
  );
  assert.equal(c.editorState.undo.length, 2);
  vm.runInContext("history()", c);
  assert.ok(
    c.editorState.edits.palette_groups.some(
      (g) => g.includes("#164188") && g.includes("#ff4545"),
    ),
  );
});

function startShadeDrag(c, colors) {
  const source = {
    dataset: { colors: JSON.stringify(colors), color: colors[0] },
    matches: () => true,
    classList: { add() {}, remove() {} },
    setPointerCapture() {},
    hasPointerCapture: () => true,
    releasePointerCapture() {
      c.released = true;
    },
  };
  const event = {
    button: 0,
    pointerId: 7,
    clientX: 10,
    clientY: 10,
    target: { closest: () => source },
    preventDefault() {},
  };
  c.elements.get("palette").contains = () => true;
  c.elements.get("palette").events.pointerdown(event);
  c.events.get("pointermove")({ ...event, clientX: 50 });
  return event;
}

test("joining compact color circles renders both original bubbles after drop, reload and undo/redo", () => {
  const c = editor();
  vm.runInContext(
    `
    const blues=['#123c80','#133c80','#143c80','#153c80'];
    const reds=['#ff4545','#fe4545','#fd4545','#fc4545'];
    state.paths=[...blues,...reds].map((color,i)=>path('p'+i,color));
    state.edits.palette_groups=[blues,reds];
    paletteControls=()=>{};
    apply=()=>palette();
    palette();
  `,
    c,
  );
  const stage = c.elements.get("palette");
  assert.equal(stage.children.length, 2);
  const blue = stage.children[0].children[1];
  const redCircle = stage.children[1];
  const red = redCircle.children[1];
  const beforeColors = [blue.dataset.color, red.dataset.color].sort();
  redCircle.classList = { add() {}, remove() {} };
  c.hit = { closest: () => redCircle };
  const event = startShadeDrag(c, JSON.parse(blue.dataset.colors));
  c.events.get("pointerup")({ ...event, clientX: 50 });
  function verify() {
    assert.equal(stage.children.length, 1);
    const dots = stage.children[0].children.slice(1);
    assert.equal(dots.length, 2);
    assert.deepEqual(dots.map((d) => d.dataset.color).sort(), beforeColors);
    assert.equal(
      dots.reduce((n, d) => n + JSON.parse(d.dataset.colors).length, 0),
      8,
    );
  }
  verify();
  vm.runInContext(
    "state.edits=JSON.parse(JSON.stringify(state.edits)); palette();",
    c,
  );
  verify();
  vm.runInContext("history()", c);
  assert.equal(stage.children.length, 2);
  vm.runInContext("history(true)", c);
  verify();
});

test("dropping over an inner shade joins its circle without implicitly merging fills", () => {
  const c = editor();
  const target = {
    dataset: { colors: '["#ff4545","#ff5050"]' },
    classList: { add() {}, remove() {} },
  };
  c.hit = {
    closest(selector) {
      assert.equal(selector, ".palette-group");
      return target;
    },
  };
  const event = startShadeDrag(c, ["#164188"]);
  c.events.get("pointerup")({ ...event, clientX: 50 });
  assert.deepEqual(Object.keys(c.editorState.edits.fills), []);
  assert.ok(
    c.editorState.edits.palette_groups.some(
      (g) => g.length === 3 && g.includes("#164188") && g.includes("#ff4545"),
    ),
  );
  assert.equal(c.released, true);
});

test("dragging a compact bundle out keeps its shades together and does not restore cleanup sources", () => {
  const c = editor();
  vm.runInContext(
    `state.edits.palette_sources={a:'#113b7f'};
    state.paletteGroups=PaletteColors.regroup(new Map([['#123c80',1],['#164188',1],['#ffffff',1],['#ff4545',1],['#ff5050',1]]), [['#123c80','#164188','#ffffff'],['#ff4545','#ff5050']]);`,
    c,
  );
  const stage = c.elements.get("palette");
  stage.closest = () => null;
  c.hit = stage;
  const event = startShadeDrag(c, ["#123c80", "#164188"]);
  c.events.get("pointerup")({ ...event, clientX: 50 });
  assert.ok(
    c.editorState.edits.palette_groups.some(
      (g) => g.length === 2 && g.includes("#123c80") && g.includes("#164188"),
    ),
  );
  assert.equal(c.editorState.edits.palette_sources.a, "#113b7f");
  assert.equal(Object.keys(c.editorState.edits.fills).length, 0);
  assert.equal(c.editorState.undo.length, 1);
  vm.runInContext("history()", c);
  assert.equal(c.editorState.undo.length, 0);
});

test("release position wins over stale hover and dropping back on the source is a no-op", () => {
  const c = editor();
  const target = {
    dataset: { colors: '["#ff4545","#ff5050"]' },
    classList: { add() {}, remove() {} },
  };
  c.hit = { closest: () => target };
  let event = startShadeDrag(c, ["#123c80"]);
  c.hit = null;
  c.events.get("pointerup")({ ...event, clientX: 500 });
  assert.equal(c.editorState.undo.length, 0);
  const own = {
    dataset: { colors: '["#123c80","#164188"]' },
    classList: { add() {}, remove() {} },
  };
  c.hit = { closest: () => own };
  event = startShadeDrag(c, ["#123c80"]);
  c.events.get("pointerup")({ ...event, clientX: 50 });
  assert.equal(c.editorState.undo.length, 0);
});

test("lost pointer capture cancels a drag and Split never restores merged artwork", () => {
  const c = editor();
  const stage = c.elements.get("palette");
  stage.closest = () => null;
  c.hit = stage;
  const event = startShadeDrag(c, ["#123c80"]);
  stage.events.lostpointercapture(event);
  c.events.get("pointerup")({ ...event, clientX: 50 });
  assert.equal(c.editorState.undo.length, 0);
  vm.runInContext(
    `state.edits.palette_sources={a:'#113b7f'}; splitPalette(['#123c80']);`,
    c,
  );
  assert.equal(Object.keys(c.editorState.edits.fills).length, 0);
  assert.equal(c.editorState.edits.palette_sources.a, "#113b7f");
});

test("merged shades can be restored after serializing and reloading editor state", () => {
  const c = editor();
  vm.runInContext(
    `mergePalette(['#123c80','#164188'], ['#ff4545','#ff5050'], '#ff4545');
    state.edits = JSON.parse(JSON.stringify(state.edits));
    state.paletteGroups = PaletteColors.regroup(new Map([['#ff4545',4],['#ffffff',1]]),state.edits.palette_groups);
    restorePalette(['#ff4545']);`,
    c,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(c.editorState.edits.fills)), {
    a: "#123c80",
    b: "#164188",
    c: "#ff4545",
    d: "#ff5050",
  });
  assert.equal(Object.keys(c.editorState.edits.palette_sources).length, 0);
});

test("bubble packing keeps every shade within its circle without overlapping", () => {
  for (const n of [1, 2, 8, 25, 120]) {
    const { diameter, dots } = PaletteColors.bubbles(
      Array.from({ length: n }, (_, i) => ({ count: i + 1 })),
    );
    assert.equal(dots.length, n);
    for (const a of dots)
      assert.ok(
        Math.hypot(a.x - diameter / 2, a.y - diameter / 2) + a.size / 2 <=
          diameter / 2,
      );
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++)
        assert.ok(
          Math.hypot(dots[i].x - dots[j].x, dots[i].y - dots[j].y) >=
            (dots[i].size + dots[j].size) / 2,
        );
  }
});

test("cancelled pointer drag and click without dragging do not edit colors", () => {
  const c = editor();
  const source = {
    dataset: { colors: '["#123c80"]', color: "#123c80" },
    matches: () => true,
    classList: { add() {}, remove() {} },
    setPointerCapture() {},
  };
  const event = {
    button: 0,
    pointerId: 1,
    clientX: 10,
    clientY: 10,
    target: { closest: () => source },
    preventDefault() {},
  };
  c.elements.get("palette").events.pointerdown(event);
  c.events.get("pointerup")(event);
  assert.equal(c.editorState.undo.length, 0);
  c.elements.get("palette").events.pointerdown(event);
  c.events.get("pointermove")({ ...event, clientX: 50 });
  c.events.get("pointercancel")();
  c.events.get("pointerup")(event);
  assert.equal(c.editorState.undo.length, 0);
});

test("automatic cleanup merges only near-identical shades into their most-used color", () => {
  const c = editor();
  vm.runInContext(
    `
    state.paths = [path('a','#123c80'), path('b','#123c80'), path('c','#133d81'),
      path('d','#ff4545'),path('e','#133d81',true),path('f','#ffffff')];
    state.edits.palette_groups = [['#123c80'],['#133d81'],['#ff4545'],['#ffffff']];
    tidyPalette(true);
  `,
    c,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(c.editorState.edits.fills)), {
    c: "#123c80",
  });
  assert.equal(c.editorState.edits.palette_sources.c, "#133d81");
  assert.equal(c.editorState.edits.palette_auto_merged, true);
  assert.equal(c.editorState.undo.length, 1);
  vm.runInContext("tidyPalette(true)", c);
  assert.equal(c.editorState.undo.length, 1);
  vm.runInContext("history(); tidyPalette(true)", c);
  assert.equal(Object.keys(c.editorState.edits.fills).length, 0);
  assert.equal(c.editorState.undo.length, 0);
  assert.equal(c.editorState.edits.palette_auto_merged, true);
});

test("tidy combines nearby nuance circles without flattening visibly different shades", () => {
  const c = editor();
  vm.runInContext(
    `state.paths = state.paths.filter(p => ['#123c80','#164188','#ffffff'].includes(p.getAttribute('fill')));
    state.edits.palette_groups = state.paletteGroups.flatMap(g => g.colors.map(c => [c]));
    tidyPalette();`,
    c,
  );
  assert.ok(
    c.editorState.edits.palette_groups.some(
      (g) => g.includes("#123c80") && g.includes("#164188"),
    ),
  );
  assert.equal(Object.keys(c.editorState.edits.fills).length, 0);
});

test("near-identical clustering cannot bridge a chain into a visibly different color", () => {
  const colors = new Map(
    Array.from({ length: 100 }, (_, n) => {
      const v = (n + 80).toString(16);
      return [`#${v}${v}${v}`, 1];
    }),
  );
  const groups = PaletteColors.group(colors, 0.018);
  assert.ok(groups.length > 10);
  for (const g of groups)
    for (const a of g.entries)
      for (const b of g.entries)
        assert.ok(PaletteColors.distance(a.lab, b.lab) <= 0.018 + 1e-10);
});

const partition = (groups) =>
  groups
    .map((g) => [...g.colors].sort())
    .sort((a, b) => a[0].localeCompare(b[0]));
test("closest boundary shades stay together regardless of shape frequency", () => {
  const colors = new Map([
    ["#707070", 100],
    ["#8c8c8c", 1],
    ["#8d8d8d", 1],
    ["#ababab", 100],
  ]);
  const grouped = PaletteColors.group(colors);
  assert.ok(
    grouped.some(
      (g) => g.colors.includes("#8c8c8c") && g.colors.includes("#8d8d8d"),
    ),
  );
  assert.deepEqual(
    partition(grouped),
    partition(
      PaletteColors.group(new Map([...colors].map(([c, n]) => [c, 101 - n]))),
    ),
  );
});

test("pale opposing hues and dark opposing hues do not share a circle", () => {
  const groups = PaletteColors.group(
    new Map(
      [
        "#f4dce5",
        "#efd9da",
        "#dcefe2",
        "#dae8f8",
        "#dedee0",
        "#142340",
        "#301b39",
      ].map((c) => [c, 1]),
    ),
  );
  const index = (c) => groups.findIndex((g) => g.colors.includes(c));
  assert.equal(index("#f4dce5"), index("#efd9da"));
  assert.notEqual(index("#f4dce5"), index("#dcefe2"));
  assert.notEqual(index("#f4dce5"), index("#dae8f8"));
  assert.notEqual(index("#142340"), index("#301b39"));
  for (const g of groups)
    for (const a of g.colors)
      for (const b of g.colors)
        assert.ok(PaletteColors.similarity(a, b) <= 1 + 1e-10);
});

test("neutral hues and hue wraparound do not introduce artificial boundaries", () => {
  const groups = PaletteColors.group(
    new Map(["#808080", "#818182", "#ff0050", "#ff0040"].map((c) => [c, 1])),
  );
  assert.ok(
    groups.some(
      (g) => g.colors.includes("#808080") && g.colors.includes("#818182"),
    ),
  );
  assert.ok(
    groups.some(
      (g) => g.colors.includes("#ff0050") && g.colors.includes("#ff0040"),
    ),
  );
});

test("all grouping modes respect their own limits and preserve every color", () => {
  const colors = new Map(
    Array.from({ length: 180 }, (_, i) => [
      "#" + ((i * 7919) % 16777216).toString(16).padStart(6, "0"),
      1,
    ]),
  );
  for (const mode of ["tight", "balanced", "broad"]) {
    const groups = PaletteColors.group(colors, mode);
    assert.equal(new Set(groups.flatMap((g) => g.colors)).size, colors.size);
    for (const g of groups)
      for (const a of g.colors)
        for (const b of g.colors)
          assert.ok(PaletteColors.similarity(a, b, mode) <= 1 + 1e-10);
    assert.deepEqual(
      partition(groups),
      partition(PaletteColors.group(new Map([...colors].reverse()), mode)),
    );
  }
});

test("migration repairs old circles once without recoloring or overwriting subsequent manual groups", () => {
  const c = editor();
  vm.runInContext(
    `state.edits.palette_auto_merged=true;
    state.edits.palette_groups=[['#123c80','#ff4545'],['#164188'],['#ff5050'],['#ffffff']];
    regroupPalette(undefined,true);`,
    c,
  );
  assert.equal(Object.keys(c.editorState.edits.fills).length, 0);
  assert.ok(
    c.editorState.edits.palette_groups.some(
      (g) => g.includes("#123c80") && g.includes("#164188"),
    ),
  );
  assert.equal(c.editorState.edits.palette_grouping_version, 3);
  vm.runInContext(
    `state.edits.palette_groups=[['#123c80','#ff4545'],['#164188'],['#ff5050'],['#ffffff']];
    regroupPalette(undefined,true);`,
    c,
  );
  assert.ok(
    c.editorState.edits.palette_groups.some(
      (g) => g.includes("#123c80") && g.includes("#ff4545"),
    ),
  );
  assert.equal(c.editorState.undo.length, 1);
  vm.runInContext("history(); regroupPalette(undefined,true);", c);
  assert.equal(c.editorState.undo.length, 0);
});

test("changing grouping precision is undoable and never changes artwork fills", () => {
  const c = editor();
  vm.runInContext(`regroupPalette('tight');regroupPalette('broad');`, c);
  assert.equal(c.editorState.edits.palette_grouping_mode, "broad");
  assert.equal(Object.keys(c.editorState.edits.fills).length, 0);
  vm.runInContext("history()", c);
  assert.equal(c.editorState.edits.palette_grouping_mode, "tight");
});

test("automatic groups do not leave two fully compatible circles separate", () => {
  const colors = new Map(
    Array.from({ length: 90 }, (_, i) => [
      "#" + ((i * 151003) % 16777216).toString(16).padStart(6, "0"),
      1,
    ]),
  );
  const groups = PaletteColors.group(colors);
  for (let i = 0; i < groups.length; i++)
    for (let j = i + 1; j < groups.length; j++)
      assert.ok(
        groups[i].colors.some((a) =>
          groups[j].colors.some((b) => PaletteColors.similarity(a, b) > 1),
        ),
      );
});

test("large-palette compression preserves every shade and never mixes incompatible hues", () => {
  const colors = new Map(
    Array.from({ length: 1200 }, (_, i) => {
      const r = 145 + (i % 40),
        g = 170 + (Math.floor(i / 40) % 30),
        b = 195 + (i % 17);
      return [
        "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join(""),
        1,
      ];
    }),
  );
  const groups = PaletteColors.group(colors);
  assert.equal(groups.flatMap((g) => g.colors).length, 1200);
  for (const g of groups)
    for (let i = 0; i < g.colors.length; i++)
      for (let j = i + 1; j < g.colors.length; j++)
        assert.ok(
          PaletteColors.similarity(g.colors[i], g.colors[j]) <= 1 + 1e-10,
        );
});
