import { createMemo, createSignal } from "solid-js";
import { createResourceView, type createResourceRuntime } from "@pocketjs/framework/resource-view";
import { offloadResource } from "@pocketjs/framework/resource-offload";
import type { ResourceLoad } from "@pocketjs/framework/resource-cache";
import { getOps } from "@pocketjs/framework/host";
import { visibleTiles } from "@pocketjs/framework/tile-viewport";
import type { offload } from "@pocketjs/framework/offload";
import { MARKER_KINDS, type MapInfo, type MapMarker, type MarkerInput, type MarkerLayer } from "../shared/types.ts";
export const LAYERS: { id: MarkerLayer; name: string }[] = [
  { id: "all", name: "All map labels" },
  { id: "travel", name: "Places, shrines & towers" },
  { id: "collectibles", name: "Koroks & treasures" },
  { id: "enemies", name: "Enemies" },
  { id: "off", name: "Hide labels" },
];
const metrics = new Map<string, { text: string; width: number }>();
export function labelMetrics(name: string) {
  const cached = metrics.get(name);
  if (cached) return cached;
  const unicode = /[^\x20-\x7e]/.test(name);
  const width = (text: string) => (unicode ? text.length * 13 : getOps().measureText(text, 0));
  let text = name;
  while (text.length > 1 && width(text) > 166) text = text.slice(0, -1);
  if (text !== name) {
    text = text.slice(0, -3) + "...";
  }
  const result = { text, width: Math.min(174, Math.ceil(width(text)) + 8) };
  metrics.set(name, result);
  if (metrics.size > 256) metrics.delete(metrics.keys().next().value!);
  return result;
}
export const labelWidth = (name: string) => labelMetrics(name).width;
/** `load` replaces the offload `map.markers` read with another transport's
 * loader (relay resource.get); the window budget and validation stay. */
export function createAnnotations(io: ReturnType<typeof offload>, runtime: ReturnType<typeof createResourceRuntime>, viewport = { width: 400, height: 240 }, load?: ResourceLoad<MarkerInput, string>) {
  const [layer, setLayer] = createSignal<MarkerLayer>("all"),
    [demand, setDemand] = createSignal<MarkerInput[]>([]);
  const collection = runtime.createCollection({
    key: (i: MarkerInput) => `${i.source}/${i.layer}/${i.z}/${i.x}/${i.y}`,
    maxEntries: 40,
    maxViews: 1,
    maxDemandsPerView: 12,
    cost: () => 8192,
    maxCost: 40 * 8192,
    maxResponseBytes: 5000,
    load: load ?? offloadResource<MarkerInput>(io, "map.markers", JSON.stringify),
    materialize(raw: string): MapMarker[] {
      const rows = JSON.parse(raw);
      if (
        !Array.isArray(rows) ||
        rows.length > 12 ||
        !rows.every(
          (m) =>
            Array.isArray(m) &&
            m.length === 5 &&
            Number.isSafeInteger(m[0]) &&
            typeof m[1] === "string" &&
            m[1].length <= 24 &&
            MARKER_KINDS.includes(m[2]) &&
            Number.isFinite(m[3]) &&
            Number.isFinite(m[4]) &&
            m[3] >= 0 &&
            m[3] < 256 &&
            m[4] >= 0 &&
            m[4] < 256,
        )
      )
        throw new Error("Invalid map annotations");
      return rows;
    },
  });
  const view = createResourceView(collection, {
    demand: () => demand().map((input) => ({ input, priority: 25, pin: true })),
  });
  const rows = createMemo(() => demand().flatMap((i) => view.value(i) ?? []).sort((a, b) => a[0] - b[0]));
  const [renderRows, setRenderRows] = createSignal<MapMarker[]>([]);
  let last: { x: number; y: number; zoom: number; rows: MapMarker[] } | undefined;
  let settled = false;
  let demandAt: { x: number; y: number; zoom: number; level: number; info: MapInfo; layer: MarkerLayer } | undefined;
  let placements = new Map<number, { x: number; y: number; width: number }>();
  return {
    layer,
    setLayer,
    rows,
    renderRows,
    placement: (id: number) => placements.get(id),
    reset() {
      setDemand([]); setRenderRows([]); placements.clear(); last = undefined; demandAt = undefined;
      collection.clear();
    },
    /** Keep the resident windows visible and refetch them (authority
     * invalidation or a new relay session). */
    refresh(matches?: (input: MarkerInput) => boolean) { collection.invalidate(matches); },
    update(camera: { x: number; y: number; zoom: number }, level: number, info: MapInfo) {
      if (info.render === "mesh") level = Math.min(info.maxZoom, Math.max(0, Math.round(camera.zoom)));
      const vector = info.render === "mesh",
        size = vector ? 256 : 512;
      const cells = Math.max(1, 2 ** (vector ? level : level - 1));
      const demandChanged = !demandAt || demandAt.x !== camera.x || demandAt.y !== camera.y
        || demandAt.zoom !== camera.zoom || demandAt.level !== level
        || demandAt.info !== info || demandAt.layer !== layer();
      if (demandChanged) {
        demandAt = { ...camera, level, info, layer: layer() };
        const next: MarkerInput[] =
          info.markers && layer() !== "off"
            ? visibleTiles({
                ...camera,
                zoom: vector ? camera.zoom : level,
                level,
                width: viewport.width,
                height: viewport.height,
                tileSize: size,
                maxTiles: vector ? 12 : 4,
              })
                .filter((t) => t.row >= 0 && t.row < cells && (vector || (t.column >= 0 && t.column < cells)))
                .map((t) => ({
                  source: info.source,
                  z: level,
                  x: vector ? ((t.column % cells) + cells) % cells : t.column,
                  y: t.row,
                  layer: layer(),
                }))
            : [];
        const old = demand();
        if (next.length !== old.length || next.some((v, n) => {
          const o = old[n]; return !o || v.source !== o.source || v.layer !== o.layer || v.z !== o.z || v.x !== o.x || v.y !== o.y;
        })) setDemand(next);
      }
      const candidates = rows();
      if (settled && last?.x === camera.x && last.y === camera.y && last.zoom === camera.zoom && last.rows === candidates) return;
      last = { ...camera, rows: candidates };
      if (vector) {
        const placed = new Map<number, { x: number; y: number; width: number }>(), names = new Set<string>();
        const shown = renderRows(), retained = new Map(shown.map(m => [m[0], m])), selected: MapMarker[] = [];
        const scale = 2 ** camera.zoom;
        function place(marker: MapMarker) {
          if (placed.size >= 12 || placed.has(marker[0]) || names.has(marker[1])) return;
          let dx = marker[3] - camera.x; dx -= Math.round(dx / 256) * 256;
          const width = labelWidth(marker[1]), x = viewport.width / 2 + dx * scale - width / 2, y = viewport.height / 2 + (marker[4] - camera.y) * scale - 7;
          if (x < 2 || x + width > viewport.width - 2 || y < 29 || y > viewport.height - 32) return;
          for (const p of placed.values()) if (x < p.x + p.width + 4 && x + width + 4 > p.x && Math.abs(y - p.y) < 19) return;
          placed.set(marker[0], { x, y, width }); names.add(marker[1]); selected.push(retained.get(marker[0]) ?? marker);
        }
        // Keep visible identities first without sorting the whole candidate
        // window each frame. Mount at most ONE newly visible label per frame;
        // candidates outside the screen never create UI nodes/frame hooks.
        for (const marker of candidates) if (retained.has(marker[0])) place(marker);
        const retainedCount = selected.length;
        for (const marker of candidates) place(marker);
        settled = selected.length <= retainedCount + 1;
        const mounted = selected.slice(0, retainedCount + 1);
        for (let i = mounted.length; i < selected.length; i++) placed.delete(selected[i][0]);
        placements = placed;
        if (mounted.length !== shown.length || mounted.some((m, i) => m !== shown[i])) setRenderRows(mounted);
      } else {
        placements.clear(); settled = true;
        setRenderRows(candidates); // Hyrule retains its bounded icon markers.
      }
    },
  };
}
