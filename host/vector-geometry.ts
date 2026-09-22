import { invalid, tooLarge } from "../shared/failure.ts";
import { VectorTile, classifyRings, type VectorTileFeature } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import earcut from "earcut";
import { prepareMesh, type OffloadMesh } from "@pocketjs/framework/offload/provider";
export type Point = { x: number; y: number };
export interface VectorLabel {
  name: string;
  x: number;
  y: number;
  rank: number;
  maxZoom: number;
  path?: Point[];
}
export interface PreparedTile {
  mesh: OffloadMesh;
  labels: VectorLabel[];
  triangles: number;
  vertices: number;
  simplified: number;
}
const color = (hex: number) => (0xff000000 | ((hex & 255) << 16) | (hex & 0xff00) | (hex >>> 16)) >>> 0;
const LAND = color(0xf0ede3),
  WATER = color(0xa6cddd),
  PARK = color(0xc0d4ab),
  BUILDING = color(0xd8d2c6),
  ROAD = color(0xfffdf7),
  EDGE = color(0xc7bfae),
  MAIN = color(0xf5cf83);
/** Quantize shared coordinates once; clip triangles AFTER tessellation so holes
 * retain their topology, including polygons crossing the tile boundary. */
export class MeshBuilder {
  points: [number, number][] = [];
  faces: [number, number, number, number][] = [];
  priority = 0;
  private indices = new Map<string, number>();
  triangle(a: Point, b: Point, c: Point, fill: number) {
    let poly = [a, b, c];
    for (const [axis, bound, le] of [
      ["x", 0, false],
      ["x", 256, true],
      ["y", 0, false],
      ["y", 256, true],
    ] as const) {
      const next: Point[] = [];
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i],
          q = poly[(i + 1) % poly.length],
          d = p[axis] - bound,
          e = q[axis] - bound,
          ip = le ? d <= 0 : d >= 0,
          iq = le ? e <= 0 : e >= 0;
        if (ip) next.push(p);
        if (ip !== iq) {
          const t = d / (d - e);
          next.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
        }
      }
      poly = next;
      if (poly.length < 3) return;
    }
    const ids = poly.map((p) => {
      const x = Math.max(0, Math.min(4096, Math.round(p.x * 16))),
        y = Math.max(0, Math.min(4096, Math.round(p.y * 16))),
        key = `${x}/${y}`;
      let id = this.indices.get(key);
      if (id === undefined) {
        id = this.points.length;
        this.points.push([x, y]);
        this.indices.set(key, id);
      }
      return id;
    });
    for (let i = 1; i < ids.length - 1; i++) {
      const [p, q, r] = [this.points[ids[0]], this.points[ids[i]], this.points[ids[i + 1]]];
      if ((q[0] - p[0]) * (r[1] - p[1]) !== (q[1] - p[1]) * (r[0] - p[0]))
        this.faces.push([ids[0], ids[i], ids[i + 1], fill]);
    }
  }
  polygon(rings: Point[][], fill: number) {
    const coords: number[] = [],
      holes: number[] = [];
    for (const ring of rings) {
      if (coords.length) holes.push(coords.length / 2);
      for (const p of ring) coords.push(p.x, p.y);
    }
    const indices = earcut(coords, holes, 2);
    for (let i = 0; i < indices.length; i += 3) {
      const p = (n: number) => ({ x: coords[n * 2], y: coords[n * 2 + 1] });
      this.triangle(p(indices[i]), p(indices[i + 1]), p(indices[i + 2]), fill);
    }
  }
  line(points: Point[], width: number, fill: number) {
    // Bounded miter joins share vertices; no gaps at segment junctions.
    if (points.length < 2) return;
    const left: Point[] = [],
      right: Point[] = [];
    const normal = (a: Point, b: Point) => {
      const dx = b.x - a.x,
        dy = b.y - a.y,
        n = Math.hypot(dx, dy) || 1;
      return { x: -dy / n, y: dx / n };
    };
    for (let i = 0; i < points.length; i++) {
      const a = normal(points[Math.max(0, i - 1)], points[i]),
        b = normal(points[i], points[Math.min(i + 1, points.length - 1)]);
      let nx = a.x + b.x,
        ny = a.y + b.y;
      const len = Math.hypot(nx, ny) || 1;
      nx /= len;
      ny /= len;
      const dot = Math.abs(nx * (i === 0 ? b.x : a.x) + ny * (i === 0 ? b.y : a.y));
      const half = (width * 0.5) / Math.max(0.5, dot);
      left.push({ x: points[i].x + nx * half, y: points[i].y + ny * half });
      right.push({ x: points[i].x - nx * half, y: points[i].y - ny * half });
    }
    for (let i = 1; i < points.length; i++) {
      this.triangle(left[i - 1], right[i - 1], left[i], fill);
      this.triangle(right[i - 1], right[i], left[i], fill);
    }
  }
  /** Admit a complete feature or leave the builder unchanged. */
  append(other: MeshBuilder): boolean {
    if (!other.faces.length) return true;
    if (this.faces.length + other.faces.length > 2048) return false;
    const fresh: [number, number][] = [], remap: number[] = [];
    for (const point of other.points) {
      const existing = this.indices.get(`${point[0]}/${point[1]}`);
      remap.push(existing ?? this.points.length + fresh.length);
      if (existing === undefined) fresh.push(point);
    }
    if (this.points.length + fresh.length > 4096) return false;
    for (const point of fresh) {
      this.indices.set(`${point[0]}/${point[1]}`, this.points.length);
      this.points.push(point);
    }
    for (const [a, b, c, fill] of other.faces) this.faces.push([remap[a], remap[b], remap[c], fill]);
    return true;
  }
  entry(): OffloadMesh {
    return prepareMesh({
      width: 256,
      height: 256,
      vertices: this.points.map(([x, y]) => [x / 16, y / 16]),
      triangles: this.faces,
    });
  }
}

/** Last detail pass: choose complete features, then restore painter order.
 * Geographic areas outrank decoration; long major roads outrank short links.
 * This guarantees a bounded mesh even when a dense source survives simplification. */
class BudgetMeshBuilder extends MeshBuilder {
  private features: { mesh: MeshBuilder; priority: number; order: number }[] = [];
  override polygon(rings: Point[][], fill: number) {
    const mesh = new MeshBuilder();
    mesh.polygon(rings, fill);
    this.features.push({ mesh, priority: this.priority, order: this.features.length });
  }
  override line(points: Point[], width: number, fill: number) {
    const mesh = new MeshBuilder();
    mesh.line(points, width, fill);
    let length = 0;
    for (let i = 1; i < points.length; i++)
      length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    this.features.push({ mesh, priority: this.priority + length, order: this.features.length });
  }
  finish(): MeshBuilder {
    const budget = new MeshBuilder();
    const selected = this.features.sort((a, b) => b.priority - a.priority || a.order - b.order)
      .filter((feature) => budget.append(feature.mesh));
    const result = new MeshBuilder();
    for (const feature of selected.sort((a, b) => a.order - b.order)) result.append(feature.mesh);
    return result;
  }
}
function simplify(points: Point[], epsilon: number): Point[] {
  if (points.length <= 3) return points;
  // Iterative Douglas-Peucker: host work, no recursion proportional to geometry.
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const work: [number, number][] = [[0, points.length - 1]];
  while (work.length) {
    const [a, b] = work.pop()!,
      p = points[a],
      q = points[b],
      dx = q.x - p.x,
      dy = q.y - p.y,
      len = dx * dx + dy * dy;
    let best = epsilon * epsilon,
      at = -1;
    for (let i = a + 1; i < b; i++) {
      const t = len ? Math.max(0, Math.min(1, ((points[i].x - p.x) * dx + (points[i].y - p.y) * dy) / len)) : 0;
      const x = points[i].x - p.x - t * dx,
        y = points[i].y - p.y - t * dy,
        d = x * x + y * y;
      if (d > best) {
        best = d;
        at = i;
      }
    }
    if (at >= 0) {
      keep[at] = 1;
      work.push([a, at], [at, b]);
    }
  }
  const result = points.filter((_, i) => keep[i]);
  return result.length >= 3
    ? result
    : points.length > 3 && points[0].x === points.at(-1)!.x && points[0].y === points.at(-1)!.y
      ? points
      : result;
}
function ringArea(ring: Point[]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}
type Feature = {
  layer: string;
  kind: string;
  type: number;
  rings: Point[][];
  polygons: Point[][][];
  properties: VectorTileFeature["properties"];
};
const AREAS = [
  "ocean",
  "water_polygons",
  "land",
  "landcover",
  "sites",
  "buildings",
  "street_polygons",
  "pier_polygons",
];
const LINES = ["water_lines", "boundaries", "streets", "pier_lines"];

/** Join degree-two endpoints before simplifying. MVT features often split one
 * road into hundreds of short links; simplifying each link cannot reduce it.
 * Junctions remain endpoints, so simplification cannot cut across a branch. */
export function joinLinePaths(paths: Point[][]): Point[][] {
  const edges = paths.filter((p) => p.length >= 2);
  const nodes = new Map<string, { edge: number; end: number }[]>();
  const key = (p: Point) => `${p.x}/${p.y}`;
  for (const [edge, path] of edges.entries())
    for (const end of [0, 1]) {
      const k = key(path[end ? path.length - 1 : 0]);
      const links = nodes.get(k) ?? [];
      links.push({ edge, end });
      nodes.set(k, links);
    }
  const used = new Uint8Array(edges.length), result: Point[][] = [];
  const walk = (edge: number, reverse: boolean) => {
    const joined: Point[] = [];
    while (!used[edge]) {
      used[edge] = 1;
      const path = edges[edge];
      for (let j = joined.length ? 1 : 0; j < path.length; j++)
        joined.push(path[reverse ? path.length - 1 - j : j]);
      const links = nodes.get(key(joined[joined.length - 1]))!;
      if (links.length !== 2) break;
      const next = links.find((link) => !used[link.edge]);
      if (!next) break;
      edge = next.edge;
      reverse = next.end === 1;
    }
    result.push(joined);
  };
  for (const [edge, path] of edges.entries()) {
    if (used[edge]) continue;
    if (nodes.get(key(path[0]))!.length !== 2) walk(edge, false);
    else if (nodes.get(key(path[path.length - 1]))!.length !== 2) walk(edge, true);
  }
  for (let edge = 0; edge < edges.length; edge++) if (!used[edge]) walk(edge, false);
  return result;
}

/** At coarse detail, subpixel parallel links and short interchange edges have
 * the same coverage. Snap to a tile-aligned grid and deduplicate before joining. */
export function generalizeLinePaths(paths: Point[][], grid: number): Point[][] {
  const edges = new Map<string, Point[]>();
  const snap = (p: Point) => ({ x: Math.round(p.x / grid) * grid, y: Math.round(p.y / grid) * grid });
  const key = (p: Point) => `${p.x}/${p.y}`;
  for (const path of paths) {
    if (!path.length) continue;
    let a = snap(path[0]);
    for (let i = 1; i < path.length; i++) {
      const b = snap(path[i]), ka = key(a), kb = key(b);
      if (ka !== kb) edges.set(ka < kb ? `${ka}:${kb}` : `${kb}:${ka}`, [a, b]);
      a = b;
    }
  }
  return joinLinePaths([...edges.values()]);
}

function joinedLines(features: Feature[], grid: number): Feature[] {
  const groups = new Map<string, Feature>();
  for (const f of features) {
    if (!LINES.includes(f.layer)) continue;
    const key = `${f.layer}/${f.kind}`;
    let group = groups.get(key);
    if (!group) {
      group = { ...f, rings: [] };
      groups.set(key, group);
    }
    for (const ring of f.rings) group.rings.push(ring);
  }
  return [...groups.values()].map((f) => ({ ...f, rings: grid ? generalizeLinePaths(f.rings, grid) : joinLinePaths(f.rings) }));
}
function roadWidth(kind: string, z: number) {
  return /motorway|trunk/.test(kind)
    ? 3.0
    : /primary|secondary/.test(kind)
      ? 2.4
      : /tertiary/.test(kind)
        ? 1.8
        : /residential|unclassified|service/.test(kind)
          ? z >= 13
            ? 1.1
            : 0.65
          : 0.5;
}
export function prepareVector(bytes: Uint8Array, z: number): PreparedTile {
  if (bytes.length > 2 * 1024 * 1024) throw tooLarge("Vector source body exceeds budget");
  const tile = new VectorTile(new PbfReader(bytes)),
    features: Feature[] = [],
    labels: VectorLabel[] = [];
  let total = 0;
  for (const [name, layer] of Object.entries(tile.layers)) {
    if (![...AREAS, ...LINES, "place_labels", "street_labels", "pois"].includes(name)) continue;
    if (layer.length > 20000) throw tooLarge("Vector feature budget exceeded");
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i),
        geometry = f.loadGeometry();
      total += geometry.reduce((n, r) => n + r.length, 0);
      if (total > 200000) throw tooLarge("Vector point budget exceeded");
      if (!Number.isInteger(f.extent) || f.extent < 1 || f.extent > 65536) throw invalid("Invalid vector extent");
      const scale = 256 / f.extent,
        rings = geometry.map((r) => r.map((p) => ({ x: p.x * scale, y: p.y * scale })));
      if (
        rings.some((r) =>
          r.some(
            (p) => !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 65536 || Math.abs(p.y) > 65536,
          ),
        )
      )
        throw invalid("Invalid vector coordinates");
      const kind = String(f.properties.kind ?? ""),
        properties = f.properties;
      if (name.includes("labels") || name === "pois") {
        const text = String(properties["name:en"] ?? properties.name_en ?? properties.name ?? "")
          .trim()
          .slice(0, 24);
        if (!text) continue;
        const line = rings.reduce((a, b) => (a.length >= b.length ? a : b), [] as Point[]);
        if (!line.length) continue;
        let anchor = line[0];
        if (line.length > 1) {
          let length = 0;
          for (let j = 1; j < line.length; j++)
            length += Math.hypot(line[j].x - line[j - 1].x, line[j].y - line[j - 1].y);
          let remaining = length / 2;
          for (let j = 1; j < line.length; j++) {
            const a = line[j - 1],
              b = line[j],
              d = Math.hypot(b.x - a.x, b.y - a.y);
            if (d >= remaining) {
              const t = d ? remaining / d : 0;
              anchor = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
              break;
            }
            remaining -= d;
          }
        }
        if (name === "street_labels" || anchor.x >= 0 && anchor.x < 256 && anchor.y >= 0 && anchor.y < 256)
          labels.push({
            name: text,
            ...anchor,
            rank: name === "place_labels" ? 0 : name === "street_labels" ? 2 : 4,
            maxZoom:
              name === "place_labels"
                ? /country|state/.test(kind)
                  ? 10
                  : /city/.test(kind)
                    ? 14
                    : /town/.test(kind)
                      ? 16
                      : 18
                : 18,
            path: name === "street_labels" ? simplify(line, 0.15) : undefined,
          });
        continue;
      }
      const polygons =
        f.type === 3
          ? classifyRings(geometry).map((p) => p.map((r) => r.map((q) => ({ x: q.x * scale, y: q.y * scale }))))
          : [];
      features.push({ layer: name, kind, type: f.type, rings, polygons, properties });
    }
  }
  // Complete features at successively coarser detail; never cut an arbitrary
  // triangle prefix which could erase a polygon's holes or half a road.
  const tolerances = [0.25, 0.5, 1, 2, 3, 5, 8, 12, 16, 20, 24];
  for (let detail = 0; detail < tolerances.length; detail++) {
    const drawing = detail === tolerances.length - 1 ? new BudgetMeshBuilder() : new MeshBuilder();
    drawing.priority = Infinity;
    drawing.polygon(
      [
        [
          { x: 0, y: 0 },
          { x: 256, y: 0 },
          { x: 256, y: 256 },
          { x: 0, y: 256 },
        ],
      ],
      LAND,
    );
    const epsilon = tolerances[detail];
    for (const layer of AREAS)
      for (const f of features.filter((f) => f.layer === layer)) {
        if (
          (detail >= 2 && layer === "buildings") ||
          (detail >= 4 && ["sites", "street_polygons", "pier_polygons"].includes(layer))
        )
          continue;
        const fill = /water|ocean/.test(layer)
          ? WATER
          : layer === "buildings"
            ? BUILDING
            : /park|wood|forest|grass|scrub|garden|farmland/.test(f.kind)
              ? PARK
              : layer === "sites"
                ? color(0xe3dfcf)
                : LAND;
        for (const polygon of f.polygons) {
          if (detail >= 2 && Math.abs(ringArea(polygon[0])) < epsilon * epsilon) continue;
          drawing.priority = (["ocean", "water_polygons", "land"].includes(layer) ? 1e9 : 1e6) + Math.abs(ringArea(polygon[0]));
          drawing.polygon(
            polygon.filter((r, i) => i === 0 || detail < 2 || Math.abs(ringArea(r)) >= epsilon * epsilon)
              .map((r) => simplify(r, Math.min(epsilon, 2))), fill,
          );
        }
      }
    const lines = (detail >= 6 ? joinedLines(features, [0, 0.5, 1, 1, 2][detail - 6]) : features)
      .filter((f) => LINES.includes(f.layer))
      .sort((a, b) => roadWidth(a.kind, z) - roadWidth(b.kind, z));
    for (const f of lines) {
      if (detail >= 3 && /path|foot|cycle|service|tram/.test(f.kind)) continue;
      if (detail >= 5 && f.layer === "pier_lines") continue;
      if (detail >= 6 && f.layer === "boundaries") continue;
      if (detail >= 7 && f.layer === "water_lines" && f.kind === "canal") continue;
      if (detail >= 7 && f.layer === "streets" && roadWidth(f.kind, z) < 2.4) continue;
      if (detail >= 5 && f.layer === "streets" && roadWidth(f.kind, z) < 1.8) continue;
      const paths = f.rings.map((r) => simplify(r, Math.min(epsilon, 2)));
      const width = roadWidth(f.kind, z);
      drawing.priority = f.layer === "streets" ? width * 1e7 : 1e6;
      if (f.layer === "streets") {
        if (detail < 6) for (const p of paths) drawing.line(p, width + (detail >= 1 ? 0.3 : 0.6), EDGE);
        for (const p of paths) drawing.line(p, width, /motorway|trunk|primary|secondary/.test(f.kind) ? MAIN : ROAD);
      } else
        for (const p of paths)
          drawing.line(p, f.layer === "water_lines" ? 0.8 : 0.5, f.layer === "water_lines" ? WATER : EDGE);
    }
    const mesh = drawing instanceof BudgetMeshBuilder ? drawing.finish() : drawing;
    if (mesh.points.length <= 4096 && mesh.faces.length <= 2048) {
      const picked = labels.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name)).slice(0, 512);
      return {
        mesh: mesh.entry(),
        labels: picked,
        vertices: mesh.points.length,
        triangles: mesh.faces.length,
        simplified: detail,
      };
    }
  }
  throw tooLarge("Vector tile cannot fit the device detail budget");
}

/** Choose stable anchors within a requested display tile. A z18 label window
 * reuses its z14 source; street names are positioned on the clipped line. */
export function labelsInWindow(
  tile: PreparedTile,
  zoom: number,
  left: number,
  top: number,
  size: number,
): VectorLabel[] {
  const result: VectorLabel[] = [],
    factor = 256 / size;
  for (const source of tile.labels) {
    if (zoom > source.maxZoom) continue;
    let anchor: Point | undefined;
    if (source.path) {
      let longest = 0;
      for (let i = 1; i < source.path.length; i++) {
        const a = source.path[i - 1],
          b = source.path[i],
          dx = b.x - a.x,
          dy = b.y - a.y;
        let lo = 0,
          hi = 1;
        for (const [p, q] of [
          [-dx, a.x - left],
          [dx, left + size - a.x],
          [-dy, a.y - top],
          [dy, top + size - a.y],
        ]) {
          if (p === 0) {
            if (q < 0) {
              hi = -1;
              break;
            }
            continue;
          }
          const r = q / p;
          if (p < 0) lo = Math.max(lo, r);
          else hi = Math.min(hi, r);
        }
        const length = (hi - lo) * Math.hypot(dx, dy);
        if (hi > lo && length > longest) {
          longest = length;
          const t = (lo + hi) / 2;
          anchor = { x: a.x + dx * t, y: a.y + dy * t };
        }
      }
      if (longest * factor < 24) continue;
    } else if (source.x >= left && source.x < left + size && source.y >= top && source.y < top + size) anchor = source;
    if (
      !anchor ||
      result.some(
        (p) =>
          p.name === source.name ||
          (Math.abs(p.x - anchor!.x) * factor < 76 && Math.abs(p.y - anchor!.y) * factor < 19),
      )
    )
      continue;
    result.push({ ...source, ...anchor });
    if (result.length === 12) break;
  }
  return result;
}
