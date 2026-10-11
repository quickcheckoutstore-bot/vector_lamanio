"use strict";
// OKLab measures visual color differences more consistently than RGB distance.
const PaletteColors = (() => {
  function lab(hex) {
    const [r, g, b] = hex.match(/[a-f\d]{2}/gi).map((v) => {
      const c = parseInt(v, 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  }
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const presets = {
    tight: { distance: 0.065, hue: 28, chroma: 0.05 },
    balanced: { distance: 0.095, hue: 40, chroma: 0.075 },
    broad: { distance: 0.125, hue: 55, chroma: 0.1 },
  };
  function entry(color, count) {
    const value = lab(color);
    return {
      color,
      count,
      lab: value,
      chroma: Math.hypot(value[1], value[2]),
      hue: Math.atan2(value[2], value[1]),
    };
  }
  function pairScore(a, b, limits) {
    const delta = distance(a.lab, b.lab) + (a.radius || 0) + (b.radius || 0);
    if (!limits.hue || delta <= 0.018) return delta / limits.distance;
    const angle =
      (Math.min(
        Math.PI,
        Math.acos(Math.max(-1, Math.min(1, Math.cos(a.hue - b.hue)))) +
          (a.hueRadius || 0) +
          (b.hueRadius || 0),
      ) *
        180) /
      Math.PI;
    // Hue is unstable close to gray. Fade its influence instead of hard hue bins.
    const reliability = Math.max(
      0,
      Math.min(
        1,
        (Math.min(a.chromaMax ?? a.chroma, b.chromaMax ?? b.chroma) - 0.008) /
          0.032,
      ),
    );
    return Math.max(
      delta / limits.distance,
      (angle * reliability) / limits.hue,
      Math.max(
        Math.abs((a.chromaMin ?? a.chroma) - (b.chromaMax ?? b.chroma)),
        Math.abs((b.chromaMin ?? b.chroma) - (a.chromaMax ?? a.chroma)),
      ) / limits.chroma,
    );
  }
  function similarity(a, b, mode = "balanced") {
    return pairScore(
      entry(a, 1),
      entry(b, 1),
      presets[mode] || presets.balanced,
    );
  }
  function finish(entries) {
    entries.sort(
      (a, b) => a.lab[0] - b.lab[0] || a.color.localeCompare(b.color),
    );
    const main = [...entries].sort(
      (a, b) => b.count - a.count || a.color.localeCompare(b.color),
    )[0];
    return {
      main,
      entries,
      colors: entries.map((e) => e.color),
      count: entries.reduce((n, e) => n + e.count, 0),
    };
  }
  function group(colors, mode = "balanced") {
    const limits =
      typeof mode === "number"
        ? { distance: mode }
        : presets[mode] || presets.balanced;
    const entries = [...colors]
      .map(([color, count]) => entry(color, count))
      .sort((a, b) => a.color.localeCompare(b.color));
    const clusters = [],
      buckets = new Map(),
      heap = [];
    const cell = (value) => value.map((v) => Math.floor(v / limits.distance));
    const key = (value) => value.join(",");
    const before = (a, b) =>
      a.score < b.score ||
      (a.score === b.score && (a.a < b.a || (a.a === b.a && a.b < b.b)));
    function push(item) {
      heap.push(item);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!before(item, heap[p])) break;
        heap[i] = heap[p];
        i = p;
      }
      heap[i] = item;
    }
    function pop() {
      const first = heap[0],
        last = heap.pop();
      if (heap.length) {
        let i = 0;
        while (i * 2 + 1 < heap.length) {
          let child = i * 2 + 1;
          if (child + 1 < heap.length && before(heap[child + 1], heap[child]))
            child++;
          if (!before(heap[child], last)) break;
          heap[i] = heap[child];
          i = child;
        }
        heap[i] = last;
      }
      return first;
    }
    function add(members) {
      const cluster = {
        id: clusters.length,
        entries: members,
        alive: true,
        anchor: members[0].lab,
      };
      clusters.push(cluster);
      const address = key(cell(cluster.anchor));
      if (!buckets.has(address)) buckets.set(address, []);
      buckets.get(address).push(cluster.id);
      return cluster;
    }
    function nearest(a) {
      let best = null;
      const origin = cell(a.anchor);
      for (let x = -1; x <= 1; x++)
        for (let y = -1; y <= 1; y++)
          for (let z = -1; z <= 1; z++) {
            for (const id of buckets.get(
              key([origin[0] + x, origin[1] + y, origin[2] + z]),
            ) || []) {
              const b = clusters[id];
              if (
                !b.alive ||
                b === a ||
                distance(a.anchor, b.anchor) > limits.distance
              )
                continue;
              let score = 0;
              outer: for (const first of a.entries)
                for (const second of b.entries) {
                  score = Math.max(score, pairScore(first, second, limits));
                  if (score > 1 || (best && score > best.score)) break outer;
                }
              if (
                score <= 1 &&
                (!best ||
                  score < best.score ||
                  (score === best.score && id < best.b))
              )
                best = { a: a.id, b: id, score };
            }
          }
      if (best) push(best);
    }
    if (entries.length > 1024) {
      // Sub-visible microcells keep large native palettes responsive. Even the
      // opposite corners are much closer than the strictest merge threshold.
      const micro = new Map(),
        size = Math.min(
          entries.length > 4096 ? 0.006 : 0.004,
          limits.distance / 4,
        );
      for (const e of entries) {
        const address = key(e.lab.map((v) => Math.floor(v / size)));
        if (!micro.has(address)) micro.set(address, []);
        micro.get(address).push(e);
      }
      for (const members of micro.values()) {
        const center = members
          .reduce((sum, e) => sum.map((v, i) => v + e.lab[i]), [0, 0, 0])
          .map((v) => v / members.length);
        const hue = Math.atan2(center[2], center[1]);
        // Conservative bounds guarantee that compression never admits a pair
        // that the full color-by-color test would reject.
        add([
          {
            lab: center,
            hue,
            members,
            radius: Math.max(...members.map((e) => distance(center, e.lab))),
            hueRadius: Math.max(
              ...members.map((e) =>
                Math.abs(
                  Math.atan2(Math.sin(e.hue - hue), Math.cos(e.hue - hue)),
                ),
              ),
            ),
            chromaMin: Math.min(...members.map((e) => e.chroma)),
            chromaMax: Math.max(...members.map((e) => e.chroma)),
          },
        ]);
      }
    } else entries.forEach((e) => add([e]));
    clusters.forEach(nearest);
    // Complete-link scores can only rise after a merge. Stale nearest-neighbor
    // entries are lower bounds and can be refreshed lazily, with O(n) heap storage.
    while (heap.length) {
      const next = pop(),
        a = clusters[next.a],
        b = clusters[next.b];
      if (!a.alive) continue;
      if (!b.alive) {
        nearest(a);
        continue;
      }
      a.alive = b.alive = false;
      const combined = add([...a.entries, ...b.entries]);
      a.entries = [];
      b.entries = [];
      nearest(combined);
    }
    return clusters
      .filter((g) => g.alive)
      .map((g) => finish(g.entries.flatMap((e) => e.members || [e])))
      .sort((a, b) => {
        const hue = (e) =>
          e.chroma < 0.02 ? -1 : (e.hue + Math.PI * 2) % (Math.PI * 2);
        return hue(a.main) - hue(b.main) || a.main.lab[0] - b.main.lab[0];
      });
  }
  // Pixel coverage, not SVG path count, reveals the paint colors of flat artwork.
  // Suppress neighboring peaks before discarding low-coverage edge mixtures.
  function anchors(histogram) {
    const total = [...histogram.values()].reduce((a, b) => a + b, 0);
    const peaks = [];
    for (const [color, count] of [...histogram].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )) {
      const e = entry(color, count);
      let nearest,
        delta = Infinity;
      for (const p of peaks) {
        const d = distance(e.lab, p.lab);
        if (d < delta) {
          nearest = p;
          delta = d;
        }
      }
      if (delta < 0.035) nearest.count += count;
      else peaks.push(e);
    }
    return peaks
      .filter((p) => p.count >= total * 0.005)
      .sort((a, b) => b.count - a.count)
      .slice(0, 64);
  }
  function paintGroups(colors, paints, mode = "balanced") {
    if (!paints?.length) return group(colors, mode);
    const entries = [...colors].map(([c, n]) => entry(c, n));
    // Ignore source paints that are no longer present after removal/recoloring.
    const active = paints.filter((p) =>
      entries.some((e) => distance(e.lab, p.lab) < 0.045),
    );
    if (!active.length) return group(colors, mode);
    const buckets = active.map(() => []),
      other = new Map();
    const radius = { tight: 0.085, balanced: 0.14, broad: 0.19 }[mode] || 0.14;
    const rgb = (c) => c.match(/[a-f\d]{2}/gi).map((v) => parseInt(v, 16));
    const paintRGB = active.map((p) => rgb(p.color));
    function isEdgeMixture(e) {
      const value = rgb(e.color);
      let bestError = Infinity,
        endpoint = -1;
      for (let i = 0; i < active.length; i++)
        for (let j = i + 1; j < active.length; j++) {
          const a = paintRGB[i],
            direction = paintRGB[j].map((v, k) => v - a[k]);
          const length = direction.reduce((s, v) => s + v * v, 0);
          if (!length) continue;
          const t =
            direction.reduce((s, v, k) => s + v * (value[k] - a[k]), 0) /
            length;
          if (t <= 0 || t >= 1) continue;
          const error = Math.hypot(
            ...value.map((v, k) => v - a[k] - t * direction[k]),
          );
          if (error < bestError) {
            bestError = error;
            endpoint =
              distance(e.lab, active[i].lab) <= distance(e.lab, active[j].lab)
                ? i
                : j;
          }
        }
      return bestError <= 24 ? endpoint : -1;
    }
    for (const e of entries) {
      let index = 0,
        best = Infinity;
      active.forEach((p, i) => {
        const d = distance(e.lab, p.lab);
        if (d < best) {
          best = d;
          index = i;
        }
      });
      const edge = best > radius ? isEdgeMixture(e) : -1;
      if (best <= radius) buckets[index].push(e);
      else if (edge >= 0) buckets[edge].push(e);
      else other.set(e.color, e.count);
    }
    return buckets
      .flatMap((members, i) => {
        if (!members.length) return [];
        const g = finish(members);
        // An edge can contain hundreds of paths. It must not become the circle's face.
        g.main = [...members].sort(
          (a, b) =>
            distance(a.lab, active[i].lab) - distance(b.lab, active[i].lab) ||
            b.count - a.count,
        )[0];
        return [g];
      })
      .concat(group(other, mode));
  }
  function regroup(colors, saved, mode = "balanced", paints = []) {
    if (!saved?.length) return paintGroups(colors, paints, mode);
    const used = new Set(),
      result = [];
    const add = (members) => {
      const entries = members
        .filter((c) => colors.has(c) && !used.has(c))
        .map((color) => {
          used.add(color);
          return { color, count: colors.get(color), lab: lab(color) };
        });
      if (!entries.length) return;
      entries.sort((a, b) => a.lab[0] - b.lab[0]);
      const paint = paints
        .filter((p) => entries.some((e) => distance(e.lab, p.lab) < 0.045))
        .sort((a, b) => b.count - a.count)[0];
      const main = [...entries].sort((a, b) =>
        paint
          ? distance(a.lab, paint.lab) - distance(b.lab, paint.lab)
          : b.count - a.count,
      )[0];
      result.push({
        entries,
        main,
        colors: entries.map((e) => e.color),
        count: entries.reduce((n, e) => n + e.count, 0),
      });
    };
    saved.forEach(add);
    paintGroups(
      new Map([...colors].filter(([c]) => !used.has(c))),
      paints,
      mode,
    ).forEach((g) => add(g.colors));
    return result;
  }
  function bubbles(entries) {
    const n = entries.length,
      diameter = Math.min(240, 48 + Math.sqrt(n) * 25);
    if (n === 1)
      return {
        diameter,
        dots: [{ x: diameter / 2, y: diameter / 2, size: diameter * 0.64 }],
      };
    let step = diameter / (Math.sqrt(n) * 1.25 + 1);
    let points;
    do {
      points = [];
      for (let row = 0; row * step * 0.866 < diameter; row++) {
        for (let col = 0; col * step < diameter; col++) {
          const x = (col + 0.5 + (row % 2) * 0.5) * step,
            y = (row + 0.5) * step * 0.866;
          if (
            Math.hypot(x - diameter / 2, y - diameter / 2) <
            diameter / 2 - step * 0.6
          )
            points.push({ x, y });
        }
      }
      if (points.length < n) step *= 0.94;
    } while (points.length < n);
    points.sort(
      (a, b) =>
        Math.hypot(a.x - diameter / 2, a.y - diameter / 2) -
        Math.hypot(b.x - diameter / 2, b.y - diameter / 2),
    );
    const max = Math.max(...entries.map((e) => e.count));
    return {
      diameter,
      dots: entries.map((e, i) => ({
        ...points[i],
        size: step * (0.55 + 0.38 * Math.sqrt(e.count / max)),
      })),
    };
  }
  function swatches(g, expanded = false, saved = []) {
    if (!expanded && saved.length) {
      const remaining = new Map(g.entries.map((e) => [e.color, e]));
      const result = [];
      for (const bundle of saved) {
        const entries = bundle
          .filter((c) => remaining.has(c))
          .map((c) => remaining.get(c));
        if (!entries.length) continue;
        entries.forEach((e) => remaining.delete(e.color));
        // Keep the visible representative first when persisting a bubble.
        result.push({
          ...entries[0],
          count: entries.reduce((n, e) => n + e.count, 0),
          colors: entries.map((e) => e.color),
        });
      }
      if (remaining.size)
        result.push(...swatches(finish([...remaining.values()])));
      return result;
    }
    if (expanded || g.entries.length <= 3)
      return g.entries.map((e) => ({ ...e, colors: [e.color] }));
    const representatives = [g.main];
    for (const e of [...g.entries].sort((a, b) => b.count - a.count)) {
      if (representatives.length >= 3) break;
      if (
        e.count >= g.count * 0.15 &&
        distance(e.lab, g.main.lab) < 0.06 &&
        representatives.every((r) => distance(r.lab, e.lab) > 0.02)
      )
        representatives.push(e);
    }
    const result = representatives.map((e) => ({ ...e, count: 0, colors: [] }));
    for (const e of g.entries) {
      const target = [...result].sort(
        (a, b) => distance(a.lab, e.lab) - distance(b.lab, e.lab),
      )[0];
      target.colors.push(e.color);
      target.count += e.count;
    }
    return result;
  }
  return {
    lab,
    distance,
    group,
    regroup,
    bubbles,
    similarity,
    anchors,
    paintGroups,
    swatches,
  };
})();
if (typeof module !== "undefined") module.exports = PaletteColors;
