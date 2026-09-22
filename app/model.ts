import { createSignal, createMemo, onCleanup } from "solid-js";
import { createResourceRuntime, createResourceView } from "@pocketjs/framework/resource-view";
import { createOffloadImageCollection, createOffloadMeshCollection, offloadResource } from "@pocketjs/framework/resource-offload";
import { createTileCamera } from "@pocketjs/framework/tile-viewport";
import { offload } from "@pocketjs/framework/offload";
import { createPackedImageCollection, resourcePacks, resourcePackStats } from "@pocketjs/framework/resource-pack";
import { createRelayImageCollection, createRelayMeshCollection, relayJsonLoad, type RelayMapClient } from "./relay.ts";
import { CATALOG_NS, OBJECT_BYTES, RENDITION, labelRef, markerRef, namespaceFor, searchRef, tileRef, type MapCatalog } from "../shared/relay.ts";
import { analogX, analogY, onFrame, onButtonPress } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { inputDeltaSeconds, simulationHz, virtualNow } from "@pocketjs/framework/clock";
import { project, worldPosition, positionAt } from "./geo.ts";
import { createSavedPlaces, validPlaces, type MapMode } from "./saved.ts";
import { HOME, type TileInput, type MapInfo, type SearchInput, type Place, type MapKind } from "../shared/types.ts";

import { createMapPrediction } from "./prediction.ts";
import { createAnnotations, LAYERS } from "./annotations.ts";

export interface DrawTile { input: TileInput; column: number; row: number; priority: number }
export interface Layer { level: number; tiles: DrawTile[]; originX: number; originY: number }
export const MENU = {
  places: ["Search places", "Saved places", "Save map center", "Back to pin", "Map home"],
  map: ["Zoom in", "Zoom out", "Map labels", "Switch map", "Clear pin", "Retry tiles", "About & controls"],
};
export type MapTransport = "offload" | "relay";
export interface MapOptions {
  /** Which transport carries the map catalog (map.info), tiles, meshes,
   * markers, labels and place search. Saved places are mutations and stay on
   * offload in both modes (#437 pilot order: reads first, vault last). */
  transport?: MapTransport;
  /** Required for the relay transport: the guest endpoint over its byte channel. */
  relay?: RelayMapClient;
}
export function createMap(io = offload(), viewport = { width: 400, height: 240 }, tileEntries = 40, options: MapOptions = {}) {
  const transport: MapTransport = options.transport ?? "offload";
  const relay = transport === "relay" ? options.relay : undefined;
  if (transport === "relay" && !relay) throw new Error("The relay transport needs a relay map client");
  // Offload only: cancelled wire requests retain offload credit until their
  // response, so that queue stays bounded independently of active resource
  // jobs and the SD queue. Relay withdraws interest with CANCEL and the
  // provider answers a small CANCELLED terminal instead of the object, so
  // relay reads need no such gate (draft §3.6/§3.9).
  const reads = { ...io,
    request: (...args: Parameters<typeof io.request>) => io.pending() < 3 ? io.request(...args) : 0,
    requestImage: (...args: Parameters<typeof io.requestImage>) => io.pending() < 3 ? io.requestImage(...args) : 0,
    requestMesh: (...args: Parameters<typeof io.requestMesh>) => io.pending() < 3 ? io.requestMesh(...args) : 0,
  };
  const [info, setInfo] = createSignal<MapInfo>();
  const [online, setOnline] = createSignal(false), [status, setStatus] = createSignal("Waiting for paired Mac");
  const [mode, setMode] = createSignal<MapMode>("map");
  const [query, setQuery] = createSignal(""), [submitted, setSubmitted] = createSignal<SearchInput>();
  const [selection, setSelection] = createSignal(0), [pin, setPin] = createSignal<Place>();
  const [menu, setMenu] = createSignal<"places" | "map">(), [menuIndex, setMenuIndex] = createSignal(0);
  const [shift, setShift] = createSignal<"off" | "once" | "locked">("off"), [symbols, setSymbols] = createSignal(false);
  const [front, setFront] = createSignal<Layer>(), [back, setBack] = createSignal<Layer>();
  const [zoomHeld, setZoomHeld] = createSignal(false), [switching, setSwitching] = createSignal(false);
  const [sourceError, setSourceError] = createSignal("");
  const [requestedKind, setRequestedKind] = createSignal<MapKind>();
  const remembered = new Map<MapKind, { x: number; y: number; zoom: number; pin?: Place }>();
  const planar = () => info()?.space === "planar";
  const p = project(HOME.lat, HOME.lon);
  const packs = resourcePacks();
  const [useLocalTiles, setUseLocalTiles] = createSignal(true);
  const [localSource, setLocalSource] = createSignal<string>();
  const localMapAvailable = () => !!packs?.connected() && planar() && useLocalTiles() && localSource() === info()?.source;
  const [tileStorage, setTileStorage] = createSignal<"local" | "desktop">("desktop");
  const camera = createTileCamera({ ...viewport, x: p.x, y: p.y, zoom: HOME.zoom, minZoom: 1, maxZoom: 18, bounds: { width: 256, height: 256, wrapX: true } });
  const runtime = createResourceRuntime({ maxConcurrent: 3, startsPerFrame: 1, completionsPerFrame: 1, maxCollections: 6, available: () => !switching() && !!info() && (io.connected() || !!relay?.connected() || !!packs && planar()) });
  const tileKey = (i: TileInput) => `${i.source}/${i.z}/${i.x}/${i.y}`;
  const tilePack = (i: TileInput) => useLocalTiles() && planar() ? { name: `hyrule-${i.source}-v1`, entry: 1 + (4 ** i.z - 1) / 3 + i.y * 2 ** i.z + i.x } : undefined;
  const materialized = (storage: "local" | "desktop") => { setTileStorage(storage); if (storage === "local") setLocalSource(info()?.source); };
  const tileBudget = { maxEntries: tileEntries, maxViews: 2, maxDemandsPerView: 24, retry: { attempts: 3, delayFrames: 90, maxDelayFrames: 360 } };
  // Residence is one collection budget on both transports; relay replaces
  // the loader only (resource.get with the held revision, CANCEL on withdrawal).
  const rasterTiles = relay
    ? createRelayImageCollection<TileInput>(runtime, relay, { key: tileKey, ref: i => tileRef(i, RENDITION.raster), pack: tilePack, materialized, width: 256, height: 256, ...tileBudget })
    : createPackedImageCollection<TileInput>(runtime, { key: tileKey, pack: tilePack, fallback: { client: reads, method: "map.tile", payload: JSON.stringify }, materialized, width: 256, height: 256, ...tileBudget });
  const vector = () => info()?.render === "mesh";
  const meshTiles = relay
    ? createRelayMeshCollection<TileInput>(runtime, relay, { key: tileKey, ref: i => tileRef(i, RENDITION.mesh), ...tileBudget })
    : createOffloadMeshCollection(runtime, reads, { key: tileKey, method: "map.mesh", payload: JSON.stringify, ...tileBudget });
  const tiles = { invalidate(matches?: (input: TileInput) => boolean){rasterTiles.invalidate(matches);meshTiles.invalidate(matches);},clear(){rasterTiles.clear();meshTiles.clear();},stats:()=>vector()?meshTiles.stats():rasterTiles.stats() };
  const labelKey = (i: Place) => `${i.name}/${i.detail}`, labelBudget = { width: 256, height: 32, maxEntries: 24, maxViews: 29, maxDemandsPerView: 1 };
  const labels = relay
    ? createRelayImageCollection<Place>(runtime, relay, { key: labelKey, ref: i => labelRef(info()?.source ?? "", i), ...labelBudget })
    : createOffloadImageCollection(runtime, reads, { key: labelKey, method: "map.label", payload: i => JSON.stringify({ name: i.name, detail: i.detail }), ...labelBudget });
  const [lookAhead, setLookAhead] = createSignal<DrawTile[]>([]);
  const frontDemand=()=>[...(front()?.tiles.map(t=>({input:t.input,priority:t.priority,pin:true}))??[]),...lookAhead().map(t=>({input:t.input,priority:t.priority,pin:false}))];
  const backDemand=()=>back()?.tiles.map(t=>({input:t.input,priority:100,pin:true}))??[];
  const rasterFront=createResourceView(rasterTiles,{demand:()=>vector()?[]:frontDemand()});
  const meshFront=createResourceView(meshTiles,{demand:()=>vector()?frontDemand():[]});
  const rasterBack=createResourceView(rasterTiles,{demand:()=>vector()?[]:backDemand()});
  const meshBack=createResourceView(meshTiles,{demand:()=>vector()?backDemand():[]});
  const frontView={state:(i:TileInput)=>vector()?meshFront.state(i):rasterFront.state(i)};
  const backView={state:(i:TileInput)=>vector()?meshBack.state(i):rasterBack.state(i)};
  const searches = runtime.createCollection({ key: (i: SearchInput) => JSON.stringify(i), maxEntries: 4, maxViews: 1, maxDemandsPerView: 1,
    maxCost: 4 * 8192, cost: () => 8192, maxResponseBytes: 5000, retry: { attempts: 1, delayFrames: 60, maxDelayFrames: 60 },
    load: relay ? relayJsonLoad<SearchInput>(relay, searchRef, OBJECT_BYTES.search) : offloadResource<SearchInput>(reads, "map.search", JSON.stringify),
    materialize(raw: string): Place[] {
      const rows = JSON.parse(raw);
      if (!validPlaces(rows)) throw new Error("Invalid places response");
      return rows;
    },
  });
  const results = createResourceView(searches, { demand: () => submitted() ? [{ input: submitted()!, priority: -10, pin: true }] : [] });
  const places = createMemo(() => submitted() ? results.value(submitted()!) ?? [] : []);
  const saved = createSavedPlaces(io, runtime, mode, setMode, () => info()?.source, reads);
  const annotations = createAnnotations(reads, runtime, viewport, relay ? relayJsonLoad(relay, markerRef, OBJECT_BYTES.markers) : undefined), prediction = createMapPrediction(viewport);
  // An authority INVALIDATE (a moved source or atlas revision): keep drawing
  // the resident values, refetch them with ifRevision. The relay client has
  // already fenced the in-flight gets by generation (draft §3.8).
  const unlistenRelay = relay?.onInvalidate(event => {
    if (event.ns === CATALOG_NS) { relay.forgetCatalog(); catalogAt = 0; return; }
    if (event.ns !== namespaceFor(info()?.source ?? "")) return;
    const key = event.scope === "namespace" ? undefined : event.ref?.key;
    tiles.invalidate(key === undefined ? undefined : i => `${i.z}/${i.x}/${i.y}` === key);
    labels.invalidate(key === undefined ? undefined : i => JSON.stringify([i.name, i.detail]) === key);
    annotations.refresh(key === undefined ? undefined : i => `${i.z}/${i.x}/${i.y}` === key);
    searches.invalidate();
  });
  // A pushed catalog is the authority's atomic answer to a reload: one
  // document carries every source and revision, so map.info and the
  // namespace the tiles are fetched from move in the same step (§3.6
  // latest-snapshot).
  const unlistenCatalog = relay?.onCatalog(applyCatalog);
  onCleanup(() => { unlistenRelay?.(); unlistenCatalog?.(); });
  const typing = () => mode() === "search" || mode() === "name";
  const listing = () => mode() === "results" || mode() === "saved";
  const rows = () => mode() === "saved" ? saved.page()?.items ?? [] : places();
  const selectedIndex = () => mode() === "saved" ? saved.selection() : selection();
  function select(index: number) { const n = Math.max(0, Math.min(rows().length - 1, index)); if (mode() === "saved") saved.setSelection(n); else setSelection(n); }
  prediction.reset(camera.view());
  const maps = () => info()?.maps ?? [];
  const labelLayers = () => vector() ? [LAYERS[0],LAYERS[4]] : LAYERS;
  const choices = () => mode() === "sources" ? maps().map(m => m.name) : labelLayers().map(l => l.name);
  const choosing = () => mode() === "sources" || mode() === "layers";
  function openSources() { if (saved.busy() || saved.modal() || typing() || switching()) return; camera.stop(); setSourceError(""); setMode("sources"); setSelection(Math.max(0, maps().findIndex(m => m.kind === info()?.kind))); setMenu(undefined); }
  function choose(index = selection()) {
    if (mode() === "sources") { const kind = maps()[index]?.kind; if (kind) switchMap(kind); }
    else if (mode() === "layers") { annotations.setLayer(labelLayers()[index].id); dismiss(); }
  }
  function switchMap(kind: MapKind) {
    if (saved.busy() || saved.modal() || typing() || switching()) return;
    if (kind === info()?.kind) { dismiss(); return; }
    const old = info(); if (old?.kind) remembered.set(old.kind, { ...camera.view(), pin: pin() });
    camera.stop(); if (infoRequest) io.cancel(infoRequest); infoRequest = 0;
    setSourceError(""); setRequestedKind(kind); setSwitching(true); retryAt = 0; setMode("map"); setStatus(`Opening ${kind === "hyrule" ? "Hyrule" : "OpenStreetMap"}...`);
    // Relay: the catalog already names every installed source, so the switch
    // needs no round trip and cannot land on a table the authority replaced.
    if (catalog) applyCatalog(catalog);
  }
  /** Install the entry the requested kind names. The document is the whole
   * table, so a source that vanished from it leaves the guest on the first
   * entry rather than on a namespace the authority no longer serves. */
  function applyCatalog(next: MapCatalog) {
    catalog = next;
    catalogAt = frame + 3600;
    const wanted = requestedKind() ?? info()?.kind;
    const entry = next.maps.find(m => m.kind === wanted) ?? next.maps[0];
    if (!entry) { setSwitching(false); setStatus("No map is installed on your Mac"); return; }
    try { installInfo({ ...entry, maps: next.maps.map(m => ({ kind: m.kind!, name: m.name })) }); }
    catch { setSwitching(false); setRequestedKind(info()?.kind); setStatus("Unsupported map provider"); catalogAt = frame + 120; }
  }
  let frame = 0, previousSession = 0, previousLink = 0, infoRequest = 0, retryAt = 0, shiftAt = -10, levelAge = 0, candidateLevel = HOME.zoom;
  let catalog: MapCatalog | undefined, catalogAt = 0, catalogPending = false;
  let confirmed = false;
  let bootstrap = packs ? 0 : -1;
  onCleanup(() => { if (bootstrap > 0) packs?.cancel(bootstrap); });
  function installInfo(value: MapInfo) {
    if (typeof value.source !== "string" || !/^[a-f0-9]{16}$/.test(value.source) || typeof value.name !== "string" || typeof value.attribution !== "string" || !Number.isInteger(value.maxZoom) || value.maxZoom < 1 || value.maxZoom > 18
      || !Number.isInteger(value.minZoom ?? 1) || (value.minZoom ?? 1) < 0 || (value.minZoom ?? 1) > value.maxZoom
      || value.render !== undefined && value.render !== "mesh"
      || value.render === "mesh" && (!Number.isInteger(value.dataZoom) || value.dataZoom! < 0 || value.dataZoom! > value.maxZoom)
      || value.space !== undefined && value.space !== "mercator" && value.space !== "planar"
      || value.home !== undefined && (!validPlaces([value.home]) || (value.home.space === "planar") !== (value.space === "planar"))) throw new Error("Invalid map provider");
    if (value.maps !== undefined && (!Array.isArray(value.maps) || value.maps.length > 2 || !value.maps.every(m => (m.kind === "hyrule" || m.kind === "osm") && typeof m.name === "string" && m.name.length <= 40))) throw new Error("Invalid map catalog");
    if (info()?.source !== value.source) {
      runtime.cancel(); searches.clear(); labels.clear(); annotations.reset(); saved.reset(); setSubmitted(undefined); setQuery("");
      tiles.clear(); setFront(undefined); setBack(undefined); setLookAhead([]); setPin(undefined);
      camera.setWorld({ minZoom: value.minZoom ?? 1, maxZoom: value.maxZoom, bounds: { width: 256, height: 256, wrapX: value.space !== "planar" } });
      const resume = value.kind && remembered.get(value.kind);
      if (resume) { camera.jump(resume.x, resume.y, resume.zoom); setPin(resume.pin); }
      else if (value.home) { const home = worldPosition(value.home); camera.jump(home.x, home.y, value.home.zoom); }
      if (!resume && !value.home) { const p = project(HOME.lat, HOME.lon); camera.jump(p.x, p.y, HOME.zoom); }
      prediction.reset(camera.view()); candidateLevel = Math.round(camera.view().zoom); levelAge = 0;
    }
    setInfo(value); setRequestedKind(value.kind); setSwitching(false); setStatus("Map ready");
  }

  function search() {
    const text = query().trim(); if (!text) return;
    const v = camera.view(), pos = positionAt(v.x, v.y, planar());
    const next: SearchInput = { query: text, source: info()?.source, ...(pos.space === "planar" ? pos : { lat: Math.round(pos.lat * 10) / 10, lon: Math.round(pos.lon * 10) / 10 }) };
    searches.invalidate(i => JSON.stringify(i) === JSON.stringify(next));
    setSubmitted(next); setSelection(0); setMode("results"); camera.stop();
  }
  function openSearch() { if (saved.busy() || saved.modal() || mode() === "name" || switching() || zoomHeld()) return; camera.stop(); setMode("search"); setMenu(undefined); }
  function go(place = rows()[selectedIndex()]) {
    if (!place) return;
    if ((place.space === "planar") !== planar()) return;
    const pos = worldPosition(place); camera.jump(pos.x, pos.y, Math.min(info()?.maxZoom ?? 18, place.zoom));
    prediction.reset(camera.view());
    setPin(place); setMode("map"); setMenu(undefined);
  }
  function home(name: string, lat: number, lon: number) { go({ id: name, name, detail: "", lat, lon, zoom: 14 }); }
  function zoom(delta: number) {
    if (delta > 0 && camera.view().zoom >= (info()?.maxZoom ?? 18)) return;
    if (switching()) return;
    prediction.zoom(delta); camera.zoomBy(delta);
  }
  function key(value: string) {
    if (!typing() || saved.busy()) return;
    const change = (fn: (value: string) => string) => mode() === "name" ? saved.changeName(fn(saved.name())) : setQuery(fn);
    if (value === "DEL") change(q => q.slice(0, -1));
    else if (value === "SPACE") change(q => q.length < 80 ? q + " " : q);
    else if (value === "GO") mode() === "name" ? saved.submit() : search();
    else if (value === "SHIFT") {
      const now = virtualNow(); setShift(s => s === "locked" ? "off" : now - shiftAt < 0.35 ? "locked" : s === "off" ? "once" : "off"); shiftAt = now;
    } else if (value === "123") setSymbols(s => !s);
    else if (value.length === 1) { change(q => q.length < 80 ? q + (shift() !== "off" ? value.toUpperCase() : value) : q); if (shift() === "once") setShift("off"); }
  }
  function saveCurrent() {
    camera.stop();
    if (mode() === "results") { const selected = places()[selection()]; if (selected) { const p = worldPosition(selected); camera.jump(p.x, p.y, selected.zoom); setPin(selected); saved.begin(selected); } return; }
    const view = camera.view(), pos = positionAt(view.x, view.y, planar()), selected = pin();
    const target = selected && worldPosition(selected);
    let dx = target ? target.x - view.x : Infinity; if (!planar()) dx -= Math.round(dx / 256) * 256;
    const detail = pos.space === "planar" ? `Hyrule ${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}` : `${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}`;
    saved.begin(target && Math.hypot(dx, target.y - view.y) * view.scale < 12 ? selected! : { id: "center", name: "Map center", detail, ...pos, zoom: Math.round(view.zoom) });
  }
  function dismiss() { if (saved.busy()) return; if (mode() === "name") { saved.cancelName(); return; } setMenu(undefined); setMode("map"); camera.stop(); }
  function runMenu() {
    const i = menuIndex(), bank = menu(); setMenu(undefined); confirmed = true;
    if (bank === "places") {
      if (i === 0) openSearch(); else if (i === 1) saved.open(); else if (i === 2) saveCurrent(); else if (i === 3) go(pin()); else if (info()?.home) go(info()!.home); else home("San Francisco", HOME.lat, HOME.lon);
    } else if (bank === "map") {
      if (i < 2) zoom(i === 0 ? 1 : -1); else if (i === 2) { setMode("layers"); setSelection(labelLayers().findIndex(l => l.id === annotations.layer())); } else if (i === 3) openSources(); else if (i === 4) setPin(undefined); else if (i === 5) tiles.invalidate(); else setMode("about");
    }
  }
  onButtonPress(BTN.CIRCLE, (_pressed, buttons) => { if (buttons & BTN.ZL || saved.modal() || saved.busy() || switching() || zoomHeld()) return; if (choosing()) choose(); else if (menu()) runMenu(); else if (typing()) key("GO"); else if (listing()) go(); });
  onButtonPress(BTN.CROSS, () => { if (saved.modal()) { saved.cancelDelete(); return; } if (saved.busy()) return; if (menu()) { confirmed = true; setMenu(undefined); } else if (typing()) key("DEL"); else dismiss(); });
  onButtonPress(BTN.TRIANGLE, (_pressed, buttons) => { if (!(buttons & BTN.ZL)) openSearch(); });
  onButtonPress(BTN.SQUARE, (_pressed, buttons) => { if (!(buttons & BTN.ZL) && !switching() && mode() === "map") go(pin()); });
  for (const [button, delta] of [[BTN.UP, -1], [BTN.DOWN, 1]] as const) onButtonPress(button, (_pressed, buttons) => {
    if (saved.modal() || saved.busy() || switching() || buttons & BTN.ZL) return;
    if (menu()) setMenuIndex(i => Math.max(0, Math.min(MENU[menu()!].length - 1, i + delta)));
    else if (choosing()) setSelection(i => Math.max(0, Math.min(choices().length - 1, i + delta)));
    else if (listing()) select(selectedIndex() + delta);
  });
  onButtonPress(BTN.LEFT, () => { if (mode() === "saved" && !menu() && !saved.modal()) saved.turnPage(-1); });
  onButtonPress(BTN.RIGHT, () => { if (mode() === "saved" && !menu() && !saved.modal()) saved.turnPage(1); });
  let previousButtons = 0, zoomRepeat = 0, zoomDirection = 0;
  onFrame(buttons => {
    frame++; const session = io.session(); setOnline(session > 0 || (relay?.session() ?? 0) > 0);
    if (session !== previousSession) {
      if (infoRequest) { io.cancel(infoRequest); infoRequest = 0; }
      runtime.cancel(); retryAt = 0;
      if (session > 0) { if (!relay && (!packs || !planar() || !useLocalTiles())) tiles.invalidate(); if (!relay) { searches.invalidate(); labels.invalidate(); } saved.refresh(); setStatus("Connecting map service"); }
      else setStatus(localMapAvailable() ? "Hyrule from SD card" : "Mac disconnected - cached map");
      previousSession = session;
    }
    const link = relay?.session() ?? 0;
    if (relay && link !== previousLink) {
      // A new relay session already failed every in-flight get on its own
      // (RESYNC_REQUIRED). Resident tiles keep their revision and revalidate
      // with ifRevision: a reconnect costs one notModified terminal per
      // resident entry, not a re-transfer, unless the source moved.
      if (link > 0) { if (!packs || !planar() || !useLocalTiles()) tiles.invalidate(); labels.invalidate(); annotations.refresh(); searches.invalidate(); catalogAt = 0; catalogPending = false; }
      previousLink = link;
    }
    if (bootstrap === 0 && packs?.connected()) {
      bootstrap = packs.request("pack.read", "hyrule/0", result => {
        bootstrap = -1;
        if (!result.ok || info() || switching()) return;
        try {
          const atlas = JSON.parse(result.value);
          if (atlas.format !== "pocket-map-atlas-rgb565-v1" || atlas.tiles !== 21845 || atlas.info?.space !== "planar") return;
          installInfo({ ...atlas.info, kind: "hyrule", markers: false });
          setLocalSource(atlas.info.source); setStatus("Hyrule from SD card");
        } catch { /* Optional installation; the paired provider remains available. */ }
      }) || 0;
    }
    if (relay?.connected() && !catalogPending && (relay.catalogStale() || frame >= catalogAt)) {
      // One conditional get at a time; a notModified keeps the held document
      // and the next check is an hour of frames away, not a re-parse.
      catalogPending = relay.requestCatalog(result => {
        catalogPending = false;
        if (result.ok) { catalogAt = frame + 3600; return; }
        catalogAt = frame + 120;
        if (switching()) { setSourceError("Map unavailable. Choose again to retry."); setMode("sources"); setSwitching(false); setRequestedKind(info()?.kind); }
        if (!info()) setStatus(`Map catalog unavailable (${result.error.code})`);
      });
    }
    if (!relay && session > 0 && (bootstrap < 0 || frame >= 30 || !packs?.connected()) && !infoRequest && frame >= retryAt) {
      infoRequest = io.request("map.info", JSON.stringify({ kind: requestedKind() }), result => {
        infoRequest = 0; retryAt = frame + 3600;
        if (!result.ok) { if (switching()) { setSourceError("Map unavailable. Choose again to retry."); setMode("sources"); } setStatus(result.error); setSwitching(false); setRequestedKind(info()?.kind); retryAt = frame + 120; return; }
        try {
          const value: MapInfo = JSON.parse(result.value);
          installInfo(value);
        } catch { setSwitching(false); setRequestedKind(info()?.kind); setStatus("Unsupported map provider"); retryAt = frame + 120; }
      });
    }
    const zl = !!(buttons & BTN.ZL) && mode() === "map" && !saved.modal() && !saved.busy() && !switching();
    setZoomHeld(zl);
    const zd = zl ? (buttons & BTN.UP ? 1 : 0) - (buttons & BTN.DOWN ? 1 : 0) : 0;
    if (zl && !(previousButtons & BTN.ZL)) { camera.endDrag(0, 0); setMenu(undefined); }
    if (zd && (zd !== zoomDirection || frame >= zoomRepeat)) { zoom(zd); zoomRepeat = frame + Math.round(simulationHz() * (zd === zoomDirection ? .28 : .4)); }
    zoomDirection = zd;
    const shoulders = buttons & (BTN.LTRIGGER | BTN.RTRIGGER);
    if (!shoulders) { confirmed = false; if (menu()) setMenu(undefined); }
    else if (!zl && !switching() && !saved.modal() && !saved.busy() && !typing() && !confirmed && !menu() && shoulders !== (previousButtons & (BTN.LTRIGGER | BTN.RTRIGGER))) {
      setMenu(shoulders & BTN.LTRIGGER ? "places" : "map"); setMenuIndex(0); camera.stop();
    }
    const canPan = mode() === "map" && !shoulders && !zl && !switching() && !saved.modal();
    const axisX = canPan ? analogX() : 0, axisY = canPan ? analogY() : 0;
    const dx = canPan ? (buttons & BTN.LEFT ? 1 : 0) - (buttons & BTN.RIGHT ? 1 : 0) : 0;
    const dy = canPan ? (buttons & BTN.UP ? 1 : 0) - (buttons & BTN.DOWN ? 1 : 0) : 0;
    camera.step(inputDeltaSeconds(), dx ? dx * 180 : -axisX * 320, dy ? dy * 180 : -axisY * 320);
    previousButtons = buttons;
    if (!info()) return;
    const view = camera.view(); prediction.sample(view, inputDeltaSeconds(), !planar());
    const next = Math.min(info()!.dataZoom ?? info()!.maxZoom, Math.max(info()!.minZoom ?? 1, Math.round(view.zoom)));
    levelAge = next === candidateLevel ? levelAge + 1 : 0; candidateLevel = next;
    let level = front()?.level ?? next;
    if (next !== level && (levelAge >= 8 || Math.abs(next - level) > 1)) {
      const previous = front();
      setBack(previous ? { ...previous, tiles: previous.tiles.filter(t => frontView.state(t.input).status === "ready") } : undefined);
      level = next;
    }
    let plan;
    try { plan = prediction.plan(view, level, info()!); }
    catch { level = next; plan = prediction.plan(view, level, info()!); }
    const draw = plan.visible, ahead = plan.extra;
    annotations.update(view, next, info()!);
    if (ahead.length !== lookAhead().length || ahead.some((t, i) => { const o = lookAhead()[i]; return !o || t.input.z !== o.input.z || t.input.x !== o.input.x || t.input.y !== o.input.y; })) setLookAhead(ahead);
    const previous = front();
    if (!previous || previous.level !== level || previous.tiles.length !== draw.length || draw.some(t => !previous.tiles.some(o => o.column === t.column && o.row === t.row))) {
      // Solid's For keys by object identity. Keep overlapping tile instances;
      // a one-column pan must not remount every resource/fallback on the screen.
      const retained = draw.map(t => previous?.level === level
        ? previous.tiles.find(o => o.column === t.column && o.row === t.row && o.input.source === t.input.source) ?? t : t);
      setFront({ level, tiles: retained, originX: Math.min(...draw.map(t => t.column)) * 256, originY: Math.min(...draw.map(t => t.row)) * 256 });
    }
    if (back() && front()?.tiles.every(t => frontView.state(t.input).status === "ready")) setBack(undefined);
  });
  return { viewport, io, transport, relay, runtime, tiles, vector, labels, catalog: () => catalog, frontView, backView, info, planar, online, zoomHeld, switching, sourceError, maps, choices, choosing, choose, openSources, switchMap, annotations, status, mode, setMode, query, setQuery, submitted, results, places, selection, setSelection, pin, menu, menuIndex,
    localMapAvailable, tileStorage, useLocalTiles, setLocalTiles(value: boolean) { runtime.cancel(); setUseLocalTiles(value); tiles.clear(); },
    shift, symbols, front, back, camera, saved, typing, listing, rows, selectedIndex, select, saveCurrent, lookAhead, search, openSearch, go, zoom, key, dismiss, runMenu,
    clearBack: () => setBack(undefined),
    diagnostics: () => ({ frame, transport, pending: io.pending(), resources: runtime.stats(), tiles: tiles.stats(), camera: camera.view(), pack: resourcePackStats(), storage: tileStorage(), relay: relay?.stats() }),
  };
}
export type MapModel = ReturnType<typeof createMap>;
