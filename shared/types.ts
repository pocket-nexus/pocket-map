export type MapKind = "hyrule" | "osm";
export type Position = { space?: "mercator"; lat: number; lon: number } | { space: "planar"; x: number; y: number };
export type Place = Position & { id: string; name: string; detail: string; zoom: number };
export interface MapInfo { source: string; name: string; attribution: string; maxZoom: number; render?: "mesh"; prefetch?: boolean; dataZoom?: number; minZoom?: number;
  space?: "mercator" | "planar"; home?: Place; local?: boolean; markers?: boolean; kind?: MapKind; maps?: { kind: MapKind; name: string }[];
  /** Relay content revision of this source (atlas revision, or the source hash extended by an operator epoch). */
  revision?: string }
export interface TileInput { source: string; z: number; x: number; y: number }
export type SearchInput = Position & { query: string; source?: string };
export interface BookmarkPage { items: Place[]; offset: number; total: number }
export interface BookmarkCommand { op: string; source?: string; kind: "save" | "rename" | "remove"; id?: string; place?: Place; name?: string }
export const HOME = { lat: 37.7879, lon: -122.4075, zoom: 14 };
export function validPosition(value: unknown): value is Position {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return p.space === "planar"
    ? typeof p.x === "number" && Number.isFinite(p.x) && p.x >= 0 && p.x <= 256 && typeof p.y === "number" && Number.isFinite(p.y) && p.y >= 0 && p.y <= 256
    : (p.space === undefined || p.space === "mercator") && typeof p.lat === "number" && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && typeof p.lon === "number" && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180;
}

export const MARKER_KINDS = ["landmark", "tower", "shrine", "stable", "village", "seed", "treasure", "enemy", "special"] as const;
export type MarkerKind = typeof MARKER_KINDS[number];
export type MarkerLayer = "all" | "travel" | "collectibles" | "enemies" | "off";
export interface MarkerInput { source: string; z: number; x: number; y: number; layer: MarkerLayer }
export type MapMarker = [id: number, name: string, kind: MarkerKind, x: number, y: number];
