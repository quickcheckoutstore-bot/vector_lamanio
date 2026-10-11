"use strict";
const $ = (id) => document.getElementById(id);
const state = {
  job: null,
  svg: null,
  paths: [],
  byId: new Map(),
  selected: new Set(),
  paletteSelected: [],
  paletteGroups: [],
  palettePaints: [],
  paletteExpanded: false,
  edits: { deleted: [], fills: {}, crop: null },
  undo: [],
  redo: [],
  tool: "select",
  quality: "native",
  zoom: 1,
  pan: { x: 0, y: 0 },
  dirty: false,
  generation: 0,
  saving: null,
  saveTimer: null,
  xhr: null,
  uploadCancelled: false,
  poll: null,
  compare: false,
  loadEpoch: 0,
};
let toastTimer,
  config = {
    max_upload_mb: 256,
    max_trace_dimension: 4096,
    max_native_pixels: 16000000,
  };
function toast(message, error = false) {
  $("toast").textContent = message;
  $("toast").classList.toggle("error", error);
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 6500);
}
async function api(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let message;
    try {
      message = (await res.json()).detail;
    } catch {
      message = `Request failed (${res.status})`;
    }
    throw new Error(
      typeof message === "string" ? message : JSON.stringify(message),
    );
  }
  return res.json();
}
const clone = (value) => JSON.parse(JSON.stringify(value));
const bytes = (n) =>
  n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
function tool(name) {
  state.tool = name;
  $("canvas").dataset.tool = name;
  document.querySelectorAll("[data-tool]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tool === name);
    b.setAttribute("aria-pressed", b.dataset.tool === name);
  });
  $("canvas-hint").textContent = {
    select: "Click a shape · Shift-click for multiple",
    pan: "Drag to move your canvas",
    background: "Click a background region to remove it",
    color: "Click a vector shape to pick its color · then remove it everywhere",
    erase: "Click any shape to remove it",
    crop: "Drag a rectangle to crop your vector",
  }[name];
  if (state.compare) compare();
}
function snapshot() {
  return clone(state.edits);
}
function commit(mutate) {
  if (!state.svg) return;
  const previous = snapshot();
  mutate();
  if (JSON.stringify(previous) === JSON.stringify(state.edits)) return;
  state.undo.push(previous);
  if (state.undo.length > 60) state.undo.shift();
  state.redo = [];
  state.dirty = true;
  state.generation++;
  apply();
  scheduleSave();
}
function history(redo = false) {
  if (!state.svg) return;
  const source = redo ? state.redo : state.undo,
    target = redo ? state.undo : state.redo;
  if (!source.length) return;
  target.push(snapshot());
  const cleaned = state.edits.palette_auto_merged;
  const groupingVersion = state.edits.palette_grouping_version || 0;
  state.edits = source.pop();
  // Undo restores colors without repeating automatic cleanup on reload.
  if (cleaned) state.edits.palette_auto_merged = true;
  state.edits.palette_grouping_version = Math.max(
    groupingVersion,
    state.edits.palette_grouping_version || 0,
  );
  state.dirty = true;
  state.generation++;
  apply();
  scheduleSave();
}
function apply() {
  endPaletteDrag();
  const deleted = new Set(state.edits.deleted);
  for (const p of state.paths) {
    p.classList.toggle("removed", deleted.has(p.id));
    p.classList.toggle(
      "selected",
      state.selected.has(p.id) && !deleted.has(p.id),
    );
    p.setAttribute("fill", state.edits.fills[p.id] || p.dataset.originalFill);
  }
  for (const id of state.selected)
    if (deleted.has(id)) state.selected.delete(id);
  const m = state.job.metadata,
    crop = state.edits.crop || [0, 0, m.trace_width, m.trace_height];
  state.svg.setAttribute("viewBox", crop.join(" "));
  $("undo").disabled = !state.undo.length;
  $("redo").disabled = !state.redo.length;
  $("reset-crop").disabled = !state.edits.crop;
  $("shape-count").textContent =
    `${(state.paths.length - deleted.size).toLocaleString()} shapes · ${deleted.size} removed`;
  $("dimensions").textContent =
    `${m.width.toLocaleString()} × ${m.height.toLocaleString()} px · ${bytes(m.svg_bytes)}`;
  selection();
  palette();
  colorRemoval();
  layout();
}
function selection() {
  const size = state.selected.size;
  $("delete-selection").hidden = !size;
  $("selection-info").textContent = size
    ? `${size} part${size > 1 ? "s" : ""} selected. Remove below, or recolor in More editing tools.`
    : "Click a part to select it, or use Erase to remove it directly.";
  for (const id of ["fill", "delete-selection", "select-color"])
    $(id).disabled = !size;
  const p = state.byId.get([...state.selected][0]);
  if (p) $("fill").value = p.getAttribute("fill");
  for (const p of state.paths)
    p.classList.toggle(
      "selected",
      state.selected.has(p.id) && !p.classList.contains("removed"),
    );
}
function palette() {
  const colors = new Map();
  for (const p of state.paths)
    if (!p.classList.contains("removed")) {
      const color = p.getAttribute("fill");
      colors.set(color, (colors.get(color) || 0) + 1);
    }
  state.paletteSelected = state.paletteSelected.filter((c) => colors.has(c));
  state.paletteGroups = PaletteColors.regroup(
    colors,
    state.edits.palette_groups,
    state.edits.palette_grouping_mode,
    state.palettePaints,
  );
  $("palette-count").textContent =
    `${colors.size} colors · ${state.paletteGroups.length} circles`;
  $("palette-grouping").value = state.edits.palette_grouping_mode || "balanced";
  $("palette").replaceChildren();
  for (const [index, group] of state.paletteGroups.entries()) {
    const circle = document.createElement("div");
    circle.className = "palette-group";
    circle.dataset.colors = JSON.stringify(group.colors);
    circle.dataset.color = group.main.color;
    const swatches = PaletteColors.swatches(
      group,
      state.paletteExpanded,
      state.edits.palette_bubbles,
    );
    const pack = PaletteColors.bubbles(swatches);
    circle.style.width = circle.style.height = `${pack.diameter}px`;
    circle.style.backgroundColor = group.main.color;
    const surface = document.createElement("button");
    surface.className = "palette-group-handle";
    surface.title = `Group ${index + 1} · ${group.colors.length} shades. Drag the circle to another circle.`;
    surface.setAttribute(
      "aria-label",
      `Select group ${index + 1}, ${group.colors.length} shades`,
    );
    surface.onclick = () => selectPalette(group.colors);
    circle.append(surface);
    for (const [i, { color, count, colors: shades }] of swatches.entries()) {
      const dot = document.createElement("button"),
        position = pack.dots[i];
      dot.className = "swatch";
      dot.dataset.colors = JSON.stringify(shades);
      dot.dataset.color = color;
      dot.style.backgroundColor = color;
      dot.style.width = dot.style.height = `${position.size}px`;
      dot.style.left = `${position.x}px`;
      dot.style.top = `${position.y}px`;
      dot.title = `${color.toUpperCase()} · ${shades.length} shades · ${count} shapes. Show all shades to select each exact color.`;
      dot.setAttribute(
        "aria-label",
        `Select ${color}, ${shades.length} shades, ${count} shapes`,
      );
      dot.onclick = () => selectPalette(shades);
      circle.append(dot);
    }
    $("palette").append(circle);
  }
  if (!colors.size) {
    const empty = document.createElement("span");
    empty.className = "palette-empty";
    empty.textContent = state.svg
      ? "No colors remain. Undo to restore them."
      : "Open a traced image to see its colors.";
    $("palette").append(empty);
  }
  const old = $("palette-target").value;
  $("palette-target").replaceChildren();
  for (const [index, group] of state.paletteGroups.entries()) {
    const option = document.createElement("option");
    option.value = group.main.color;
    option.textContent = `Circle ${index + 1} · ${group.main.color.toUpperCase()}`;
    $("palette-target").append(option);
  }
  if (state.paletteGroups.some((g) => g.main.color === old))
    $("palette-target").value = old;
  paletteControls();
}
function palettePaths(colors) {
  const wanted = new Set(colors);
  return state.paths.filter(
    (p) =>
      !p.classList.contains("removed") && wanted.has(p.getAttribute("fill")),
  );
}
function selectPalette(colors) {
  state.paletteSelected = [...colors];
  state.selected = new Set(palettePaths(colors).map((p) => p.id));
  selection();
  if (colors.length === 1) {
    $("remove-color-value").value = colors[0];
    colorRemoval();
  }
  const mode = state.edits.palette_grouping_mode || "balanced";
  let other,
    best = Infinity;
  for (const group of state.paletteGroups) {
    if (group.colors.some((c) => colors.includes(c))) continue;
    let score = 0;
    pairs: for (const color of colors)
      for (const target of group.colors) {
        score = Math.max(score, PaletteColors.similarity(color, target, mode));
        if (score >= best) break pairs;
      }
    if (score < best) {
      other = group;
      best = score;
    }
  }
  if (other) $("palette-target").value = other.main.color;
  paletteControls();
}
function paletteControls() {
  $("palette-tidy").disabled =
    !state.svg || !state.paths.some((p) => !p.classList.contains("removed"));
  $("palette-regroup").disabled = $("palette-tidy").disabled;
  $("palette-grouping").disabled = $("palette-tidy").disabled;
  const colors = state.paletteSelected,
    paths = palettePaths(colors);
  $("palette-selection").textContent = paths.length
    ? `${colors.length === 1 ? colors[0].toUpperCase() : `${colors.length} shades`} · ${paths.length.toLocaleString()} shapes`
    : "Select a shade or a circle";
  $("palette-remove").disabled = !paths.length;
  $("palette-edit").disabled = !paths.length;
  $("palette-merge-selected").disabled = colors.length < 2;
  const grouped = state.paletteGroups.some(
    (g) => g.colors.length > 1 && g.colors.some((c) => colors.includes(c)),
  );
  $("palette-split").disabled = !paths.length || !grouped;
  $("palette-restore").disabled = !paths.some(
    (p) => state.edits.palette_sources?.[p.id],
  );
  const target = state.paletteGroups.find(
    (g) => g.main.color === $("palette-target").value,
  );
  $("palette-target").disabled = !paths.length;
  $("palette-merge").disabled =
    !paths.length || !target || colors.every((c) => target.colors.includes(c));
  for (const b of $("palette").querySelectorAll(".swatch")) {
    b.classList.toggle("active", colors.includes(b.dataset.color));
    b.setAttribute("aria-pressed", colors.includes(b.dataset.color));
  }
  for (const circle of $("palette").querySelectorAll(".palette-group")) {
    const active = JSON.parse(circle.dataset.colors).every((c) =>
      colors.includes(c),
    );
    circle.classList.toggle("active", active && colors.length > 1);
    circle
      .querySelector(".palette-group-handle")
      .setAttribute("aria-pressed", active);
  }
}
function movePalette(source, targetColors = [], keepTogether = false) {
  if (!state.svg || !source.length) return;
  const groups = state.paletteGroups.map((g) => g.colors);
  const sourceSet = new Set(source);
  if (targetColors.length && source.every((c) => targetColors.includes(c)))
    return;
  if (
    !targetColors.length &&
    (source.length === 1 || keepTogether) &&
    groups.some(
      (g) => g.length === source.length && g.every((c) => sourceSet.has(c)),
    )
  )
    return;
  const target = groups.findIndex((g) =>
    g.some((c) => targetColors.includes(c)),
  );
  const next = groups.map((g, i) =>
    i === target
      ? [...new Set([...g, ...source])]
      : g.filter((c) => !sourceSet.has(c)),
  );
  if (!targetColors.length)
    next.push(...(keepTogether ? [[...source]] : source.map((c) => [c])));
  // Preserve what the user dragged, rather than compacting it invisibly into
  // the destination's dominant shade on the next render or project reload.
  const bubbles = state.paletteGroups
    .flatMap((g) =>
      PaletteColors.swatches(
        g,
        state.paletteExpanded,
        state.edits.palette_bubbles,
      ).map((b) => [b.color, ...b.colors.filter((c) => c !== b.color)]),
    )
    .flatMap((bundle) => [
      bundle.filter((c) => sourceSet.has(c)),
      bundle.filter((c) => !sourceSet.has(c)),
    ])
    .filter((bundle) => bundle.length);
  state.paletteSelected = [...source];
  commit(() => {
    state.edits.palette_groups = next.filter((g) => g.length);
    state.edits.palette_bubbles = bubbles;
  });
  toast(
    targetColors.length
      ? "Colors moved into the circle."
      : keepTogether
        ? "Shade moved into its own circle."
        : "Colors split into separate circles.",
  );
}
function mergePalette(source, targetColors, targetColor) {
  if (!state.svg || !targetColors.includes(targetColor)) return;
  const colors = [...new Set([...source, ...targetColors])],
    paths = palettePaths(colors);
  if (!paths.some((p) => p.getAttribute("fill") !== targetColor)) return;
  const groups = state.paletteGroups
    .map((g) => g.colors.filter((c) => !colors.includes(c)))
    .filter((g) => g.length);
  state.paletteSelected = [targetColor];
  state.selected = new Set(paths.map((p) => p.id));
  commit(() => {
    state.edits.palette_sources ||= {};
    for (const p of paths) {
      state.edits.palette_sources[p.id] ||= p.getAttribute("fill");
      state.edits.fills[p.id] = targetColor;
    }
    state.edits.palette_groups = [...groups, [targetColor]];
  });
  toast(
    `Merged into ${targetColor.toUpperCase()}. Restore shades reverses the merge.`,
  );
}
function splitPalette(colors) {
  movePalette(colors);
}
function restorePalette(colors) {
  const paths = palettePaths(colors);
  if (paths.some((p) => state.edits.palette_sources?.[p.id])) {
    const restored = new Set(colors);
    commit(() => {
      for (const p of paths)
        if (state.edits.palette_sources?.[p.id]) {
          const color = state.edits.palette_sources[p.id];
          restored.add(color);
          state.edits.fills[p.id] = color;
          delete state.edits.palette_sources[p.id];
        }
      state.edits.palette_groups = [
        ...state.paletteGroups
          .map((g) => g.colors.filter((c) => !restored.has(c)))
          .filter((g) => g.length),
        ...[...restored].map((c) => [c]),
      ];
      state.paletteSelected = [...restored];
    });
    toast("Original shades restored and split into circles.");
  }
}
function tidyPalette(automatic = false) {
  if (!state.svg || (automatic && state.edits.palette_auto_merged)) return;
  const colors = new Map();
  for (const p of state.paths)
    if (!p.classList.contains("removed")) {
      const color = p.getAttribute("fill");
      colors.set(color, (colors.get(color) || 0) + 1);
    }
  // Only near-identical shades are flattened; wider nuance groups retain shades.
  const close = PaletteColors.group(colors, 0.018),
    mapping = new Map(),
    merged = new Set();
  for (const g of close) {
    const paint = state.palettePaints
      .filter((p) =>
        g.entries.some((e) => PaletteColors.distance(e.lab, p.lab) < 0.035),
      )
      .sort((a, b) => b.count - a.count)[0];
    if (paint)
      g.main = [...g.entries].sort(
        (a, b) =>
          PaletteColors.distance(a.lab, paint.lab) -
          PaletteColors.distance(b.lab, paint.lab),
      )[0];
    for (const color of g.colors) {
      mapping.set(color, g.main.color);
      if (g.colors.length > 1) merged.add(color);
    }
  }
  const reduced = new Map();
  for (const [color, count] of colors) {
    const target = mapping.get(color);
    reduced.set(target, (reduced.get(target) || 0) + count);
  }
  const groups = PaletteColors.paintGroups(
    reduced,
    state.palettePaints,
    state.edits.palette_grouping_mode,
  ).map((g) => g.colors);
  commit(() => {
    state.edits.palette_auto_merged = true;
    state.edits.palette_bubbles = [];
    state.edits.palette_grouping_version = 3;
    state.edits.palette_groups = groups;
    state.edits.palette_sources ||= {};
    for (const p of state.paths) {
      if (p.classList.contains("removed")) continue;
      const color = p.getAttribute("fill");
      if (!merged.has(color)) continue;
      state.edits.palette_sources[p.id] ||= color;
      if (color !== mapping.get(color))
        state.edits.fills[p.id] = mapping.get(color);
    }
    state.paletteSelected = [
      ...new Set(
        state.paletteSelected.map((c) => mapping.get(c)).filter(Boolean),
      ),
    ];
  });
  const removed = colors.size - reduced.size;
  if (!automatic || removed)
    toast(
      removed
        ? `${removed} near-identical shade${removed === 1 ? "" : "s"} merged. Undo or Restore shades to restore.`
        : "Nearby nuances grouped. No near-identical colors needed merging.",
    );
}
function regroupPalette(
  mode = state.edits.palette_grouping_mode || "balanced",
  automatic = false,
) {
  if (!state.svg || (automatic && state.edits.palette_grouping_version >= 3))
    return;
  const colors = new Map();
  for (const p of state.paths)
    if (!p.classList.contains("removed")) {
      const color = p.getAttribute("fill");
      colors.set(color, (colors.get(color) || 0) + 1);
    }
  const groups = PaletteColors.paintGroups(
    colors,
    state.palettePaints,
    mode,
  ).map((g) => g.colors);
  commit(() => {
    state.edits.palette_groups = groups;
    state.edits.palette_grouping_mode = mode;
    state.edits.palette_bubbles = [];
    state.edits.palette_grouping_version = 3;
  });
  if (!automatic)
    toast(`Organized into ${groups.length} circles. Artwork colors preserved.`);
}
let paletteDrag = null,
  paletteClickUntil = 0;
function endPaletteDrag(event) {
  if (!paletteDrag) return;
  if (
    event?.pointerId !== undefined &&
    event.pointerId !== paletteDrag.pointerId
  )
    return;
  const d = paletteDrag;
  paletteDrag = null;
  if (d.handle.hasPointerCapture?.(d.pointerId))
    d.handle.releasePointerCapture(d.pointerId);
  d.origin.classList.remove("palette-dragging");
  d.target?.classList.remove("palette-drop-target");
  d.ghost?.remove();
  $("palette").classList.remove("palette-splitting");
  $("palette").classList.remove("palette-drag-active");
}
function paletteDropAt(d, x, y) {
  d.target?.classList.remove("palette-drop-target");
  const hit = document.elementFromPoint(x, y);
  // A whole circle is one reliable target, even when the pointer is over a dot.
  const target = hit?.closest(".palette-group");
  const source = JSON.parse(d.origin.dataset.colors);
  d.target =
    target &&
    $("palette").contains(target) &&
    !source.every((c) => JSON.parse(target.dataset.colors).includes(c))
      ? target
      : null;
  d.target?.classList.add("palette-drop-target");
  d.split =
    !target &&
    Boolean(
      hit && (hit === $("palette") || hit.closest(".palette-split-zone")),
    );
  $("palette").classList.toggle("palette-splitting", d.split);
  if (d.ghost)
    d.ghost.textContent = d.target
      ? "Join circle"
      : d.split
        ? "New circle"
        : "Cancel";
}
$("palette").addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || paletteDrag) return;
  const handle = event.target.closest(".swatch, .palette-group-handle");
  if (!handle) return;
  const origin = handle.matches(".swatch")
    ? handle
    : handle.closest(".palette-group");
  paletteDrag = {
    origin,
    handle,
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    active: false,
  };
  handle.setPointerCapture(event.pointerId);
});
document.addEventListener(
  "pointermove",
  (event) => {
    const d = paletteDrag;
    if (!d || d.pointerId !== event.pointerId) return;
    if (!d.active && Math.hypot(event.clientX - d.x, event.clientY - d.y) < 7)
      return;
    if (!d.active) {
      d.active = true;
      $("palette").classList.add("palette-drag-active");
      d.origin.classList.add("palette-dragging");
      d.ghost = document.createElement("div");
      d.ghost.className = "palette-drag-preview";
      d.ghost.style.backgroundColor = d.origin.dataset.color;
      document.body.append(d.ghost);
    }
    event.preventDefault();
    d.ghost.style.left = `${event.clientX}px`;
    d.ghost.style.top = `${event.clientY}px`;
    const stage = $("palette"),
      rect = stage.getBoundingClientRect?.();
    if (
      rect &&
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
    ) {
      if (event.clientY < rect.top + 28) stage.scrollTop -= 16;
      else if (event.clientY > rect.bottom - 28) stage.scrollTop += 16;
    }
    paletteDropAt(d, event.clientX, event.clientY);
  },
  { passive: false },
);
document.addEventListener("pointerup", (event) => {
  const d = paletteDrag;
  if (!d || d.pointerId !== event.pointerId) return;
  if (d.active) paletteDropAt(d, event.clientX, event.clientY);
  const source = JSON.parse(d.origin.dataset.colors),
    target = d.target;
  if (d.active) paletteClickUntil = Date.now() + 350;
  endPaletteDrag();
  if (!d.active) return;
  if (target) {
    const colors = JSON.parse(target.dataset.colors);
    movePalette(source, colors);
  } else if (d.split) movePalette(source, [], true);
});
document.addEventListener("pointercancel", endPaletteDrag);
$("palette").addEventListener("lostpointercapture", endPaletteDrag);
window.addEventListener("blur", endPaletteDrag);
$("palette").addEventListener(
  "click",
  (event) => {
    if (Date.now() < paletteClickUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  },
  true,
);
$("palette-remove").onclick = () =>
  remove(palettePaths(state.paletteSelected).map((p) => p.id));
$("palette-edit").onclick = () => {
  document.querySelector(".more-editing").open = true;
  $("fill").focus();
  $("fill").click();
};
$("palette-split").onclick = () => splitPalette(state.paletteSelected);
$("palette-restore").onclick = () => restorePalette(state.paletteSelected);
$("palette-tidy").onclick = () => tidyPalette();
$("palette-regroup").onclick = () => regroupPalette();
$("palette-expand").onchange = () => {
  state.paletteExpanded = $("palette-expand").checked;
  palette();
};
$("palette-grouping").onchange = () =>
  regroupPalette($("palette-grouping").value);
$("palette-merge-selected").onclick = () => {
  const entries = state.paletteGroups
    .flatMap((g) => g.entries)
    .filter((e) => state.paletteSelected.includes(e.color));
  const main = entries.sort((a, b) => b.count - a.count)[0];
  if (main)
    mergePalette(state.paletteSelected, state.paletteSelected, main.color);
};
$("palette-target").onchange = paletteControls;
$("palette-merge").onclick = () => {
  const target = state.paletteGroups.find(
    (g) => g.main.color === $("palette-target").value,
  );
  if (target) movePalette(state.paletteSelected, target.colors);
};
function remove(ids) {
  if (!ids.length) return toast("No matching shapes found.");
  commit(
    () =>
      (state.edits.deleted = [...new Set([...state.edits.deleted, ...ids])]),
  );
  toast(
    `${ids.length} shape${ids.length > 1 ? "s" : ""} removed. Undo is always here.`,
  );
}
function rgb(color) {
  return color.match(/[a-f\d]{2}/gi)?.map((v) => parseInt(v, 16)) || [0, 0, 0];
}
function matches(a, b, tolerance = Number($("tolerance").value)) {
  const x = rgb(a),
    y = rgb(b);
  return (
    Math.sqrt(x.reduce((s, v, i) => s + (v - y[i]) ** 2, 0)) <= tolerance * 4.42
  );
}
function matching(color, tolerance = Number($("tolerance").value)) {
  return state.paths.filter(
    (p) =>
      !p.classList.contains("removed") &&
      matches(p.getAttribute("fill"), color, tolerance),
  );
}
function colorRemoval() {
  const ready = Boolean(state.svg && state.job?.status === "ready");
  for (const id of [
    "pick-remove-color",
    "remove-color-value",
    "remove-color-tolerance",
  ])
    $(id).disabled = !ready;
  const color = $("remove-color-value").value;
  const count = ready
    ? matching(color, Number($("remove-color-tolerance").value)).length
    : 0;
  $("remove-color-count").textContent = ready
    ? `${color.toUpperCase()} · ${count.toLocaleString()} matching shape${count === 1 ? "" : "s"} across the entire vector`
    : "Choose a color after tracing.";
  $("remove-color").disabled = !count;
}
function pickBackground(p) {
  const paths = $("same-color").checked
    ? matching(p.getAttribute("fill"))
    : [p];
  remove(paths.map((p) => p.id));
}
function edgeBackground() {
  const m = state.job.metadata,
    [x, y, w, h] = state.edits.crop || [0, 0, m.trace_width, m.trace_height];
  const hits = new Map();
  const candidates = new Set();
  const visible = state.paths
    .filter((p) => !p.classList.contains("removed"))
    .reverse();
  const points = [];
  for (let i = 0; i < 16; i++) {
    const t = (i + 0.5) / 16;
    points.push(
      [x + w * t, y + 0.5],
      [x + w * t, y + h - 0.5],
      [x + 0.5, y + h * t],
      [x + w - 0.5, y + h * t],
    );
  }
  for (const point of points) {
    const pt = new DOMPoint(...point);
    const hit = visible.find((p) => {
      try {
        const transform = p.transform.baseVal.consolidate()?.matrix;
        return p.isPointInFill(
          transform ? pt.matrixTransform(transform.inverse()) : pt,
        );
      } catch {
        return false;
      }
    });
    if (hit) {
      candidates.add(hit);
      const c = hit.getAttribute("fill");
      hits.set(c, (hits.get(c) || 0) + 1);
    }
  }
  const dominant = [...hits].sort((a, b) => b[1] - a[1])[0];
  if (!dominant || dominant[1] < points.length * 0.35)
    return toast(
      "No clear edge background found. Pick a background region manually.",
    );
  const targets = $("same-color").checked
    ? matching(dominant[0])
    : [...candidates].filter((p) =>
        matches(p.getAttribute("fill"), dominant[0]),
      );
  remove(targets.map((p) => p.id));
}
function scheduleSave() {
  clearTimeout(state.saveTimer);
  $("save-state").textContent = "Unsaved edits";
  state.saveTimer = setTimeout(
    () => save().catch((e) => toast(e.message, true)),
    600,
  );
}
async function save() {
  clearTimeout(state.saveTimer);
  if (state.saving) {
    await state.saving;
    if (state.dirty) return save();
    return;
  }
  if (!state.dirty || !state.job) return;
  const job = state.job,
    gen = state.generation,
    data = { ...snapshot(), revision: job.revision };
  $("save-state").textContent = "Saving…";
  state.saving = (async () => {
    try {
      const result = await api(`/api/jobs/${job.id}/edits`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      job.revision = result.revision;
      if (state.generation === gen) {
        state.dirty = false;
        $("save-state").textContent = "All edits saved";
      }
    } catch (e) {
      $("save-state").textContent = "Save failed · edits remain here";
      throw e;
    }
  })();
  try {
    await state.saving;
  } finally {
    state.saving = null;
  }
  if (state.dirty) return save();
}
function layout() {
  if (!state.svg) return;
  const c = $("canvas"),
    m = state.job.metadata,
    crop = state.edits.crop || [0, 0, m.trace_width, m.trace_height],
    ratio = crop[2] / crop[3];
  const width = Math.max(
    50,
    Math.min(c.clientWidth - 90, (c.clientHeight - 125) * ratio),
  );
  const height = width / ratio;
  for (const e of [$("artboard"), $("original-image")]) {
    e.style.width = `${width}px`;
    e.style.height = `${height}px`;
    e.style.transform = `translate(calc(-50% + ${state.pan.x}px),calc(-50% + ${state.pan.y}px)) scale(${state.zoom})`;
  }
  const image = $("original-image");
  image.style.objectFit = "contain";
  $("zoom-label").textContent = `${Math.round(state.zoom * 100)}%`;
}
function fit() {
  state.zoom = 1;
  state.pan = { x: 0, y: 0 };
  layout();
}
function zoom(factor) {
  state.zoom = Math.min(12, Math.max(0.1, state.zoom * factor));
  layout();
}
function compare() {
  state.compare = !state.compare;
  $("original-image").hidden = !state.compare;
  $("artboard").hidden = state.compare;
  $("compare").textContent = state.compare ? "◐ Vector" : "◐ Original";
  $("canvas-hint").textContent = state.compare
    ? "Original preview · click Vector to return"
    : "Click a shape · Shift-click for multiple";
}
function cleanSVG(text) {
  const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
  if (
    parsed.querySelector("parsererror") ||
    parsed.documentElement.localName !== "svg"
  )
    throw new Error("Invalid vector output");
  const root = parsed.documentElement;
  for (const e of [root, ...root.querySelectorAll("*")]) {
    if (!["svg", "path"].includes(e.localName)) {
      e.remove();
      continue;
    }
    for (const a of [...e.attributes])
      if (
        ![
          "xmlns",
          "width",
          "height",
          "viewBox",
          "d",
          "fill",
          "transform",
          "id",
          "fill-rule",
          "fill-opacity",
          "shape-rendering",
        ].includes(a.name)
      )
        e.removeAttribute(a.name);
  }
  return document.importNode(root, true);
}
async function readPalettePaints(jobId) {
  const image = new Image();
  image.src = `/api/jobs/${jobId}/preview`;
  await image.decode();
  const canvas = document.createElement("canvas");
  const scale = Math.min(
    1,
    768 / Math.max(image.naturalWidth, image.naturalHeight),
  );
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const histogram = new Map();
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const color =
      "#" +
      [pixels[i], pixels[i + 1], pixels[i + 2]]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("");
    histogram.set(color, (histogram.get(color) || 0) + pixels[i + 3] / 255);
  }
  return PaletteColors.anchors(histogram);
}
async function load(job) {
  document.querySelector(".recent-options").open = false;
  const epoch = ++state.loadEpoch;
  try {
    await save();
  } catch (e) {
    toast(e.message, true);
    return;
  }
  if (epoch !== state.loadEpoch) return;
  clearTimeout(state.poll);
  if (job.status === "queued" || job.status === "processing") {
    clearDocument();
    state.job = job;
    processing(job);
    return;
  }
  if (job.status !== "ready")
    return toast(job.error || "This project is no longer available.", true);
  try {
    const res = await fetch(`/api/jobs/${job.id}/svg?original=true`);
    if (!res.ok) throw new Error("Could not load vector");
    const svg = cleanSVG(await res.text());
    if (epoch !== state.loadEpoch) return;
    // Fetch fresh edits instead of using a possibly stale recent-project entry.
    job = await api(`/api/jobs/${job.id}`);
    const paints = await readPalettePaints(job.id).catch(() => []);
    if (epoch !== state.loadEpoch) return;
    state.palettePaints = paints;
    state.job = job;
    state.svg = svg;
    state.paths = [...svg.querySelectorAll("path")];
    state.byId = new Map(state.paths.map((p) => [p.id, p]));
    for (const p of state.paths)
      p.dataset.originalFill = p.getAttribute("fill");
    state.edits = clone(job.edits);
    state.edits.deleted ||= [];
    state.edits.fills ||= {};
    state.edits.crop ||= null;
    state.undo = [];
    state.redo = [];
    state.selected.clear();
    state.paletteSelected = [];
    state.dirty = false;
    state.compare = false;
    state.generation++;
    $("artboard").replaceChildren(svg);
    $("original-image").src = `/api/jobs/${job.id}/preview`;
    $("original-image").hidden = true;
    $("artboard").hidden = false;
    $("empty").hidden = true;
    $("processing").hidden = true;
    $("document-name").textContent = job.name;
    $("document-badge").textContent = "VECTOR";
    const m = job.metadata;
    $("fidelity-note").textContent = m.pixel_exact
      ? "Exact PNG: original pixel boundaries, colors and transparency preserved. No smoothing or automatic color merging. Text remains outlined pixels, not editable font text."
      : m.resized
        ? `Resized from ${m.width} × ${m.height} to ${m.trace_width} × ${m.trace_height} for tracing. Small lettering may lose detail. Re-upload with Native to preserve resolution.`
        : "Traced at source resolution. Letters are vector outlines, not editable font text. Try Exact pixel contours if smooth curves change their edges.";
    if (m.complexity_adjusted) {
      $("fidelity-note").textContent +=
        ` Color detail was automatically reduced to ${m.effective_colors} bits${m.effective_palette_colors ? ` and a ${m.effective_palette_colors}-color palette` : ""} to fit the editor's shape/size limit. Resolution and noise filtering were kept as requested; some subtle shades may merge.`;
      toast(
        `Complex design: color detail adjusted to ${m.effective_colors} bits. See the studio note.`,
      );
    }
    if (m.fragments_grouped) {
      $("fidelity-note").textContent +=
        ` ${m.original_paths.toLocaleString()} regions were packed into ${m.paths.toLocaleString()} editable shapes. Tiny fragments of the same color are grouped without dropping contours; selecting or removing a group affects all its fragments.`;
    }
    $("document-badge").textContent = m.pixel_exact
      ? "EXACT PNG"
      : m.resized
        ? "RESIZED VECTOR"
        : "NATIVE VECTOR";
    $("save-state").textContent = "All edits saved";
    for (const id of [
      "export",
      "compare",
      "auto-background",
      "pick-background",
      "crop-button",
      "reset",
    ])
      $(id).disabled = false;
    tool("select");
    fit();
    apply();
    regroupPalette(undefined, true);
    recent();
  } catch (e) {
    toast(e.message, true);
  }
}
async function recent() {
  try {
    const jobs = await api("/api/jobs");
    $("recent").replaceChildren();
    for (const job of jobs
      .filter((j) => j.status !== "cancelled")
      .slice(0, 8)) {
      const b = document.createElement("button");
      b.className = `recent-item ${job.id === state.job?.id ? "current" : ""}`;
      const icon = document.createElement("span");
      icon.className = "recent-icon";
      icon.textContent = job.status === "ready" ? "▧" : "◷";
      const text = document.createElement("span"),
        name = document.createElement("strong"),
        detail = document.createElement("small");
      name.textContent = job.name;
      detail.textContent =
        job.status === "ready"
          ? `${job.metadata.paths.toLocaleString()} shapes · ready`
          : job.stage;
      text.append(name, detail);
      b.append(icon, text);
      b.onclick = () => load(job);
      $("recent").append(b);
    }
    if (!jobs.length) {
      const p = document.createElement("p");
      p.className = "field-help";
      p.textContent = "Your designs will live here.";
      $("recent").append(p);
    }
    return jobs;
  } catch (e) {
    toast(e.message, true);
    return [];
  }
}
function processing(job) {
  state.job = job;
  $("processing").hidden = false;
  $("empty").hidden = true;
  $("upload-progress").hidden = true;
  $("processing-title").textContent = "Untangling your pixels";
  $("processing-stage").textContent = job.stage;
  $("document-name").textContent = job.name;
  $("document-badge").textContent = "TRACING";
  $("cancel").disabled = false;
  for (const id of [
    "export",
    "compare",
    "auto-background",
    "pick-background",
    "crop-button",
    "reset",
  ])
    $(id).disabled = true;
  colorRemoval();
  state.poll = setTimeout(async () => {
    try {
      const next = await api(`/api/jobs/${job.id}`);
      if (state.job?.id !== job.id) return;
      if (next.status === "ready") {
        await load(next);
        toast("Your vector is ready. Make it yours.");
      } else if (next.status === "failed" || next.status === "cancelled") {
        state.job = next;
        $("processing").hidden = true;
        $("empty").hidden = !state.svg;
        $("document-badge").textContent = "FAILED";
        toast(next.error || "Job cancelled", true);
        recent();
      } else processing(next);
    } catch (e) {
      if (state.job?.id !== job.id) return;
      $("processing-stage").textContent = "Connection interrupted. Retrying…";
      state.poll = setTimeout(() => processing(job), 3000);
    }
  }, 1300);
}
function clearDocument() {
  endPaletteDrag();
  clearTimeout(state.saveTimer);
  clearTimeout(state.poll);
  state.svg = null;
  state.paths = [];
  state.byId.clear();
  state.selected.clear();
  state.paletteSelected = [];
  state.palettePaints = [];
  state.edits = { deleted: [], fills: {}, crop: null };
  state.undo = [];
  state.redo = [];
  state.dirty = false;
  state.compare = false;
  state.generation++;
  state.loadEpoch++;
  $("remove-color-value").value = "#ffffff";
  $("remove-color-tolerance").value = "0";
  $("remove-color-tolerance-value").textContent = "0";
  colorRemoval();
  $("artboard").replaceChildren();
  $("artboard").hidden = true;
  $("original-image").hidden = true;
  $("compare").textContent = "◐ Original";
  palette();
  $("selection-info").textContent = "Select a shape after tracing.";
  $("save-state").textContent = "";
  $("shape-count").textContent = "Your next design starts here";
  for (const id of [
    "export",
    "compare",
    "auto-background",
    "pick-background",
    "crop-button",
    "reset-crop",
    "reset",
    "fill",
    "delete-selection",
    "select-color",
    "undo",
    "redo",
  ])
    $(id).disabled = true;
}
async function upload(file) {
  if (
    state.xhr ||
    state.job?.status === "processing" ||
    state.job?.status === "queued"
  )
    return toast("Finish or cancel the current upload first.");
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".png"))
    return toast("Choose a PNG file.", true);
  if (file.size > config.max_upload_mb * 1048576)
    return toast(`Choose a file under ${config.max_upload_mb} MB.`, true);
  if (state.quality === "native") {
    const header = new DataView(await file.slice(0, 24).arrayBuffer());
    if (
      header.byteLength >= 24 &&
      header.getUint32(16) * header.getUint32(20) > config.max_native_pixels
    )
      return toast(
        `Native tracing is limited to ${(config.max_native_pixels / 1000000).toLocaleString()} MP on this server. Choose Detailed to resize, or raise MAX_NATIVE_PIXELS.`,
        true,
      );
  }
  try {
    await save();
  } catch (e) {
    return toast(e.message, true);
  }
  clearDocument();
  state.uploadCancelled = false;
  state.job = null;
  $("processing").hidden = false;
  $("upload-progress").hidden = false;
  $("upload-progress").value = 0;
  $("processing-title").textContent = "Uploading your design";
  $("processing-stage").textContent = `${file.name} · ${bytes(file.size)}`;
  $("cancel").disabled = false;
  const params = new URLSearchParams({
    name: file.name,
    quality: state.quality,
    colors: $("colors").value,
    speckle: $("speckle").value,
    mode: $("mode").value,
    profile: $("profile").value,
  });
  try {
    const job = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      state.xhr = xhr;
      xhr.open("POST", `/api/jobs?${params}`);
      xhr.setRequestHeader("Content-Type", "image/png");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable)
          $("upload-progress").value = (e.loaded / e.total) * 100;
      };
      xhr.onload = () => {
        let response;
        try {
          response = JSON.parse(xhr.responseText);
        } catch {
          return reject(new Error("Server returned an invalid response"));
        }
        if (xhr.status < 300) resolve(response);
        else reject(new Error(response.detail || "Upload failed"));
      };
      xhr.onerror = () =>
        reject(new Error("Upload failed. Check the server connection."));
      xhr.onabort = () => reject(new Error("Upload cancelled"));
      xhr.send(file);
    });
    if (state.uploadCancelled) {
      await api(`/api/jobs/${job.id}`, { method: "DELETE" });
      return;
    }
    state.job = job;
    processing(job);
    recent();
  } catch (e) {
    $("processing").hidden = true;
    $("empty").hidden = !!state.svg;
    toast(e.message, true);
  } finally {
    state.xhr = null;
    $("file").value = "";
  }
}
async function cancel() {
  state.uploadCancelled = true;
  if (state.xhr) {
    state.xhr.abort();
    return;
  }
  if (!state.job) return;
  $("cancel").disabled = true;
  try {
    await api(`/api/jobs/${state.job.id}`, { method: "DELETE" });
    clearTimeout(state.poll);
    state.job.status = "cancelled";
    $("processing").hidden = true;
    $("empty").hidden = !!state.svg;
    toast("Processing cancelled.");
    recent();
  } catch (e) {
    toast(e.message, true);
    $("cancel").disabled = false;
  }
}
function exportSVG() {
  if (!state.svg) return;
  const svg = state.svg.cloneNode(true);
  for (const p of svg.querySelectorAll("path")) {
    if (p.classList.contains("removed")) p.remove();
    else {
      p.removeAttribute("class");
      p.removeAttribute("data-original-fill");
    }
  }
  svg.querySelectorAll("rect").forEach((e) => e.remove());
  const m = state.job.metadata,
    crop = state.edits.crop || [0, 0, m.trace_width, m.trace_height],
    scaleX = m.width / m.trace_width,
    scaleY = m.height / m.trace_height;
  svg.setAttribute("width", Math.round(crop[2] * scaleX));
  svg.setAttribute("height", Math.round(crop[3] * scaleY));
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const blob = new Blob(
      [
        '<?xml version="1.0" encoding="UTF-8"?>\n',
        new XMLSerializer().serializeToString(svg),
      ],
      { type: "image/svg+xml" },
    ),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = state.job.name.replace(/\.png$/i, "") + ".svg";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("SVG exported with your edits.");
  save().catch((e) =>
    toast(`Export succeeded. Server save failed: ${e.message}`, true),
  );
}
let drag = null;
function point(event) {
  return new DOMPoint(event.clientX, event.clientY).matrixTransform(
    state.svg.getScreenCTM().inverse(),
  );
}
$("canvas").addEventListener("pointerdown", (e) => {
  if (!state.svg || state.compare || e.target.closest("button")) return;
  if (state.tool === "pan" || e.button === 1 || space) {
    drag = { type: "pan", x: e.clientX, y: e.clientY, pan: { ...state.pan } };
    $("canvas").classList.add("dragging");
    $("canvas").setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  if (state.tool === "crop") {
    const p = point(e),
      m = state.job.metadata;
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.classList.add("crop-guide");
    state.svg.append(rect);
    drag = {
      type: "crop",
      start: p,
      rect,
      max: [m.trace_width, m.trace_height],
    };
    $("canvas").setPointerCapture(e.pointerId);
    return;
  }
  const p = e.target.closest("path");
  if (!p || !state.byId.has(p.id)) {
    if (!e.shiftKey) {
      state.selected.clear();
      selection();
    }
    return;
  }
  if (state.tool === "erase") remove([p.id]);
  else if (state.tool === "background") pickBackground(p);
  else if (state.tool === "color") {
    $("remove-color-value").value = p.getAttribute("fill");
    colorRemoval();
    tool("select");
    toast(
      `Picked ${p.getAttribute("fill").toUpperCase()}. Click Remove color to delete it.`,
    );
  } else {
    if (!e.shiftKey) state.selected.clear();
    if (state.selected.has(p.id)) state.selected.delete(p.id);
    else state.selected.add(p.id);
    selection();
  }
});
$("canvas").addEventListener("pointermove", (e) => {
  if (!drag) return;
  if (drag.type === "pan") {
    state.pan = {
      x: drag.pan.x + e.clientX - drag.x,
      y: drag.pan.y + e.clientY - drag.y,
    };
    layout();
  } else {
    const p = point(e),
      x = Math.max(0, Math.min(p.x, drag.start.x)),
      y = Math.max(0, Math.min(p.y, drag.start.y)),
      right = Math.min(drag.max[0], Math.max(p.x, drag.start.x)),
      bottom = Math.min(drag.max[1], Math.max(p.y, drag.start.y));
    // Round edges before subtracting so a crop stays within the source bounds.
    const rounded = [x, y, right, bottom].map((n) => Math.round(n * 100) / 100);
    drag.crop = [
      rounded[0],
      rounded[1],
      Number((rounded[2] - rounded[0]).toFixed(2)),
      Number((rounded[3] - rounded[1]).toFixed(2)),
    ];
    for (const [key, value] of Object.entries({
      x,
      y,
      width: right - x,
      height: bottom - y,
    }))
      drag.rect.setAttribute(key, value);
  }
});
function endDrag() {
  if (drag?.type === "crop") {
    drag.rect.remove();
    const crop = drag.crop;
    if (crop && crop[2] > 2 && crop[3] > 2) {
      commit(
        () => (state.edits.crop = crop.map((n) => Math.round(n * 100) / 100)),
      );
      fit();
      toast("Canvas cropped. Paths stay editable.");
    }
  }
  drag = null;
  $("canvas").classList.remove("dragging");
}
$("canvas").addEventListener("pointerup", endDrag);
$("canvas").addEventListener("pointercancel", () => {
  drag?.rect?.remove();
  drag = null;
  $("canvas").classList.remove("dragging");
});
$("canvas").addEventListener(
  "wheel",
  (e) => {
    if (!state.svg) return;
    e.preventDefault();
    zoom(e.deltaY > 0 ? 0.9 : 1.1);
  },
  { passive: false },
);
let space = false;
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input,select,textarea")) return;
  if (e.key === "Escape") endPaletteDrag();
  if (e.code === "Space" && e.target.closest(".palette-block")) return;
  if (e.code === "Space") {
    space = true;
    e.preventDefault();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    history(e.shiftKey);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
    e.preventDefault();
    history(true);
    return;
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    remove([...state.selected]);
  }
  if (e.key === "Escape") {
    state.selected.clear();
    selection();
  }
  if (
    !e.ctrlKey &&
    !e.metaKey &&
    { v: "select", h: "pan", b: "background", e: "erase", c: "crop" }[e.key]
  )
    tool(
      { v: "select", h: "pan", b: "background", e: "erase", c: "crop" }[e.key],
    );
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Space") space = false;
});
window.addEventListener("blur", () => (space = false));
document
  .querySelectorAll("[data-tool]")
  .forEach((b) => (b.onclick = () => tool(b.dataset.tool)));
document.querySelectorAll("[data-quality]").forEach(
  (b) =>
    (b.onclick = () => {
      state.quality = b.dataset.quality;
      document
        .querySelectorAll("[data-quality]")
        .forEach((e) => e.classList.toggle("active", e === b));
      if (state.quality === "native") {
        $("quality-note").textContent =
          `No resizing · up to ${(config.max_native_pixels / 1000000).toLocaleString()} MP · higher memory use`;
        return;
      }
      const limit = Math.min(
        { fast: 1024, balanced: 2048, detail: 4096 }[state.quality],
        config.max_trace_dimension,
      );
      $("quality-note").textContent =
        `Up to ${limit.toLocaleString()} px · ${{ fast: "lightweight & quick", balanced: "a little detail, a lighter file", detail: "more detail, more memory" }[state.quality]}`;
    }),
);
$("profile").onchange = () => {
  const exact = $("profile").value === "exact";
  const precise = exact || $("profile").value === "precise";
  $("colors").value = precise ? 8 : 6;
  $("speckle").value = precise ? 0 : 8;
  $("mode").value = exact ? "pixel" : "spline";
  for (const id of ["colors", "speckle", "mode"]) $(id).disabled = exact;
  document
    .querySelectorAll("[data-quality]")
    .forEach((b) => (b.disabled = false));
  $("colors-value").textContent = `${$("colors").value} bits`;
  $("speckle-value").textContent = `${$("speckle").value} px`;
  document
    .querySelector(`[data-quality="${precise ? "native" : "balanced"}"]`)
    .click();
  document
    .querySelectorAll("[data-quality]")
    .forEach((b) => (b.disabled = exact));
};
for (const [id, label] of [
  ["colors", "bits"],
  ["speckle", "px"],
  ["tolerance", ""],
])
  $(id).oninput = () =>
    ($(id + "-value").textContent = `${$(id).value} ${label}`.trim());
$("file").onchange = (e) => upload(e.target.files[0]);
$("dropzone").onkeydown = (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    $("file").click();
  }
};
for (const type of ["dragenter", "dragover"])
  $("dropzone").addEventListener(type, (e) => {
    e.preventDefault();
    $("dropzone").classList.add("dragging");
  });
$("dropzone").ondragleave = () => $("dropzone").classList.remove("dragging");
$("dropzone").ondrop = (e) => {
  e.preventDefault();
  $("dropzone").classList.remove("dragging");
  upload(e.dataTransfer.files[0]);
};
$("sample").onclick = async () => {
  try {
    const res = await fetch("/sample.png");
    if (!res.ok) throw new Error("Sample unavailable");
    upload(
      new File([await res.blob()], "botanical-study.png", {
        type: "image/png",
      }),
    );
  } catch (e) {
    toast(e.message, true);
  }
};
$("undo").onclick = () => history();
$("redo").onclick = () => history(true);
$("export").onclick = exportSVG;
$("auto-background").onclick = edgeBackground;
$("pick-background").onclick = () => tool("background");
$("pick-remove-color").onclick = () => tool("color");
$("remove-color-value").oninput = colorRemoval;
$("remove-color-tolerance").oninput = () => {
  $("remove-color-tolerance-value").textContent = $(
    "remove-color-tolerance",
  ).value;
  colorRemoval();
};
$("remove-color").onclick = () => {
  if (!state.svg || state.job?.status !== "ready") return;
  remove(
    matching(
      $("remove-color-value").value,
      Number($("remove-color-tolerance").value),
    ).map((p) => p.id),
  );
};
$("crop-button").onclick = () => tool("crop");
$("delete-selection").onclick = () => remove([...state.selected]);
$("select-color").onclick = () => {
  const p = state.byId.get([...state.selected][0]);
  if (p) {
    state.selected = new Set(matching(p.getAttribute("fill")).map((p) => p.id));
    selection();
  }
};
$("fill").onchange = () =>
  commit(() => {
    for (const id of state.selected) state.edits.fills[id] = $("fill").value;
  });
$("reset-crop").onclick = () => commit(() => (state.edits.crop = null));
$("reset").onclick = () =>
  commit(() => {
    state.edits = { deleted: [], fills: {}, crop: null };
    state.selected.clear();
  });
$("compare").onclick = compare;
$("zoom-in").onclick = () => zoom(1.2);
$("zoom-out").onclick = () => zoom(1 / 1.2);
$("fit").onclick = fit;
$("refresh").onclick = recent;
document.addEventListener("pointerdown", (event) => {
  for (const menu of document.querySelectorAll(
    ".upload-options, .recent-options",
  ))
    if (!menu.contains(event.target)) menu.open = false;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape")
    for (const menu of document.querySelectorAll(
      ".upload-options, .recent-options",
    ))
      menu.open = false;
});
$("cancel").onclick = cancel;
new ResizeObserver(layout).observe($("canvas"));
window.addEventListener("beforeunload", (e) => {
  if (state.dirty || state.xhr) {
    e.preventDefault();
    e.returnValue = "";
  }
});
(async () => {
  try {
    config = await api("/api/config");
    $("profile").onchange();
    $("upload-limit").textContent =
      `PNG · up to ${config.max_upload_mb} MB · ${Math.round(config.max_image_pixels / 1000000)} MP`;
  } catch (e) {
    toast("Could not connect to the server.", true);
  }
  const jobs = await recent();
  const latest = jobs.find((j) =>
    ["queued", "processing", "ready"].includes(j.status),
  );
  if (latest) load(latest);
})();
