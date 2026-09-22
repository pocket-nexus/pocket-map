import { createSignal, For, Show } from "solid-js";
import { AuxiliarySurface, Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { ClassicButton, ClassicFace, ClassicPanel, ClassicSheet } from "@pocketjs/framework/classic";
import { ResourceImage, ResourceMesh } from "@pocketjs/framework/resource";
import { createResourceView } from "@pocketjs/framework/resource-view";
import { createGesture, createDragFilter } from "@pocketjs/framework/gesture";
import { inputDeltaSeconds } from "@pocketjs/framework/clock";
import { onFrame } from "@pocketjs/framework/lifecycle";
import * as hot from "@pocketjs/framework/hot";
import {labelWidth,labelMetrics} from "./annotations.ts";
import { MENU, type MapModel, type Layer } from "./model.ts";
import { createMapForHost } from "./transport.ts";
import { worldPosition, unproject, scaleBar } from "./geo.ts";
import type { Place, MapMarker } from "../shared/types.ts";
import { TileLayer, Annotation } from "./map-view.tsx";
const box = (x: number, y: number, w: number, h: number) => ({ posType: 1, insetL: x, insetT: y, width: w, height: h });

function ZoomRail(p: { s: MapModel }) {
  let thumb: NodeMirror | undefined, label: NodeMirror | undefined;
  onFrame(() => {
    const v = p.s.camera.view(), min = p.s.info()?.minZoom ?? 1, max = p.s.info()?.maxZoom ?? 18;
    hot.prop(thumb, "translateY", 124 * (1 - (v.targetZoom - min) / Math.max(1, max - min)));
    hot.text(label, `${Math.round(v.targetZoom)}`);
  });
  return <Show when={p.s.zoomHeld()}><ClassicPanel active style={box(318, 32, 75, 194)}>
    <Text class="absolute left-0 right-0 top-[6] text-xs font-bold text-center text-white">Zoom</Text>
    <Text class="absolute left-[5] top-[35] text-xs text-[#536b84]">{p.s.info()?.maxZoom ?? 18}</Text>
    <View class="absolute left-[32] top-[40] w-[7] h-[132] rounded-[3] border border-[#8ca0b8] bg-[#b8c7d7]" />
    <View ref={thumb} style={box(23, 36, 26, 17)}><ClassicFace selected style={box(0, 0, 26, 17)}><Text ref={label} class="absolute left-0 right-0 top-[2] text-xs text-center text-white">4</Text></ClassicFace></View>
    <Text class="absolute left-[5] top-[160] text-xs text-[#536b84]">{p.s.info()?.minZoom ?? 1}</Text>
    <Text class="absolute left-0 right-0 bottom-[4] text-xs text-center text-[#536b84]">ZL + D-pad</Text>
  </ClassicPanel></Show>;
}
function ChoicePanel(p: { s: MapModel }) {
  return <Show when={p.s.choosing()}><ClassicPanel active style={box(46, 31, 308, 190)}>
    <Text class="absolute left-0 right-0 top-[6] text-xs font-bold text-center text-white">{p.s.mode() === "sources" ? "Choose a map" : "Map labels"}</Text>
    <For each={p.s.choices()}>{(name, i) => <ClassicFace selected={p.s.selection() === i()} style={box(9, 34 + i() * 26, 290, 24)}>
      <Text class="absolute left-[10] top-[5] text-xs" style={{ textColor: p.s.selection() === i() ? "#ffffff" : "#304f78" }}>{name}</Text>
    </ClassicFace>}</For>
    <Text class="absolute left-0 right-0 bottom-[6] text-xs text-center text-[#536b84]">{p.s.sourceError() || "D-pad: choose   A: apply   B: return"}</Text>
  </ClassicPanel></Show>;
}
function PlaceRow(p: { s: MapModel; place: Place; index: number }) {
  const unicode = /[^\x20-\x7e]/.test(p.place.name + p.place.detail);
  const image = createResourceView(p.s.labels, { demand: () => unicode && p.s.listing() ? [{ input: p.place, priority: -5, pin: true }] : [] });
  return <View debugName="PlaceResult" style={{ ...box(8, 33 + p.index * 33, 332, 32), bgColor: p.s.selectedIndex() === p.index ? "#2d74d1" : "#f7f9fc", radius: 3 }}>
    <Text class="absolute left-[5] top-[8] text-xs font-bold" style={{ textColor: p.s.selectedIndex() === p.index ? "#ffffff" : "#5c7187" }}>{p.index + 1}</Text>
    <Show when={unicode} fallback={<>
      <Text class="absolute left-[23] top-[2] text-xs font-bold" style={{ textColor: p.s.selectedIndex() === p.index ? "#ffffff" : "#263748" }}>{p.place.name.slice(0, 36)}</Text>
      <Text class="absolute left-[23] top-[17] text-xs" style={{ textColor: p.s.selectedIndex() === p.index ? "#e9f1ff" : "#627387" }}>{p.place.detail.slice(0, 43)}</Text>
    </>}><ResourceImage style={{ ...box(23, 0, 256, 32), overflow: 1 }} state={() => image.state(p.place)} fallback={() => <View class="absolute left-[8] top-[10] w-[160] h-[8] bg-[#d4dbe3] animate-pulse" />} /></Show>
  </View>;
}
function SearchResults(p: { s: MapModel }) {
  return <Show when={p.s.listing()}><ClassicPanel debugName="SearchResults" active style={box(26, 30, 348, 205)}>
    <Text class="absolute left-[12] top-[6] text-xs font-bold text-white">{p.s.mode() === "saved" ? `Saved places${p.s.saved.page() ? "  (" + p.s.saved.page()!.total + ")" : ""}` : `Places: ${p.s.query().slice(0, 32)}`}</Text>
    <For each={p.s.rows()}>{(place, i) => <PlaceRow s={p.s} place={place} index={i()} />}</For>
    <Show when={!p.s.rows().length}><Text class="absolute left-[12] top-[74] right-[12] text-center text-sm text-[#556c82]">
      {p.s.mode() === "saved" ? p.s.saved.state().status === "pending" ? "Loading saved places from your Mac..." : p.s.saved.state().status === "error" ? "Saved places unavailable. Reopen to retry." : "No saved places yet. Use Save view." : p.s.submitted() && p.s.results.state(p.s.submitted()!).status === "pending" ? "Searching with your Mac..." : p.s.submitted() && p.s.results.state(p.s.submitted()!).status === "error" ? "Search unavailable. Edit and retry." : "No places found. Try another name."}
    </Text></Show>
  </ClassicPanel></Show>;
}
function Context(p: { s: MapModel }) {
  return <Show when={p.s.menu()}>{bank => <View class="absolute left-0 top-0 w-full h-full bg-[#18263a66]">
    <ClassicPanel active style={box(63, 26, 274, 204)}>
      <Text class="absolute left-0 right-0 top-[6] text-center text-xs font-bold text-white">{bank() === "places" ? "Places" : "Map controls"}</Text>
      <For each={MENU[bank()]}>{(name, i) => <ClassicFace selected={p.s.menuIndex() === i()} style={box(9, 31 + i() * 22, 256, 20)}>
        <Text class="absolute left-[10] top-[3] text-xs" style={{ textColor: p.s.menuIndex() === i() ? "#ffffff" : "#304f78" }}>{name}</Text>
      </ClassicFace>}</For>
      <Text class="absolute left-0 right-0 bottom-[4] text-center text-xs text-[#536b84]">D-pad: choose   A: open   B: cancel</Text>
    </ClassicPanel>
  </View>}</Show>;
}
const LETTERS = ["q w e r t y u i o p", "a s d f g h j k l DEL", "SHIFT z x c v b n m .", "123 - , SPACE"];
const SYMBOLS = ["1 2 3 4 5 6 7 8 9 0", "@ # / ( ) : ; ' ? DEL", "SHIFT ! $ % & * + = .", "123 - , SPACE"];
function Keyboard(p: { s: MapModel }) {
  const [pressed, setPressed] = createSignal(""); let root: NodeMirror | undefined;
  const keys = () => (p.s.symbols() ? SYMBOLS : LETTERS).flatMap((line, row) => {
    let x = 6; return line.split(" ").map((value, col) => { const w = row === 3 ? [36, 28, 28, 216][col] : 30.8;
      const key = { value, x, y: 41 + row * 22, w: w - 2 }; x += w; return key; });
  });
  createGesture({ surface: "auxiliary", region: { node: () => root }, onDown(c) {
    if (!p.s.typing() || p.s.menu() || p.s.saved.busy()) return;
    const k = keys().find(k => c.x >= k.x && c.x < k.x + k.w && c.y >= k.y && c.y < k.y + 20);
    if (k) { setPressed(k.value); p.s.key(k.value); }
  }, onUp: () => setPressed(""), onCancel: () => setPressed("") });
  return <View ref={root} debugName="MapKeyboard" style={{ ...box(0, 40, 320, 89), display: p.s.typing() ? 0 : 1 }}>
    <For each={keys()}>{k => <ClassicFace tone="key" pressed={pressed() === k.value} selected={k.value === "SHIFT" && p.s.shift() !== "off"} style={box(k.x, k.y - 40, k.w, 20)}>
      <Show when={k.value === "SHIFT"} fallback={<Text class="absolute left-0 right-0 top-[3] text-xs text-center text-[#263950]">{k.value === "123" && p.s.symbols() ? "ABC" : k.value.length === 1 && p.s.shift() !== "off" ? k.value.toUpperCase() : k.value === "SPACE" ? "space" : k.value}</Text>}>
        <Image src={p.s.shift() === "locked" ? "shift-lock.svg" : "shift.svg"} style={box(6, 2, 16, 16)} />
      </Show>
    </ClassicFace>}</For>
  </View>;
}
function Deck(p: { s: MapModel }) {
  let pad: NodeMirror | undefined; let dy = 0;
  const filter = createDragFilter();
  const [touching, setTouching] = createSignal(false);
  const typing = p.s.typing, results = p.s.listing, saved = () => p.s.mode() === "saved", naming = () => p.s.mode() === "name";
  const blocked = () => !!p.s.menu() || p.s.saved.modal() || p.s.saved.busy() || p.s.switching() || p.s.zoomHeld();
  const top = () => typing() ? 136 : 40, height = () => 194 - top();
  createGesture({ surface: "auxiliary", region: { node: () => pad }, panSlop: 2,
    onDown() { if (blocked() || naming() || p.s.choosing()) return; setTouching(true); dy = 0; filter.reset(); p.s.camera.beginDrag(); },
    onPanMove(c) {
      if (blocked() || naming() || p.s.choosing()) return;
      if (results()) { dy += c.fdy; const step = Math.trunc(dy / 20); if (step) { p.s.select(p.s.selectedIndex() + step); dy -= step * 20; } }
      else { const delta = filter.update(c.dx, c.dy, inputDeltaSeconds()); p.s.camera.drag(delta.dx * 1.45, delta.dy * 1.45); }
    },
    onPanEnd() { setTouching(false); if (blocked() || naming() || p.s.choosing()) return; const v = filter.velocity(); p.s.camera.endDrag(results() ? 0 : v.x * 1.45, results() ? 0 : v.y * 1.45); },
    onTap() { setTouching(false); if (blocked() || naming() || p.s.choosing()) return; p.s.camera.endDrag(0, 0); if (results()) p.s.go(); },
    onCancel() { setTouching(false); p.s.camera.stop(); },
  });
  // Build fixed controls outside the outer wrapper's mount stack on QuickJS.
  const keyboard = <Keyboard s={p.s} />;
  const search = <ClassicButton debugName="SearchButton" label={typing() ? "Cancel" : saved() || p.s.mode() === "about" || p.s.choosing() ? "Map" : "Search"} surface="auxiliary" tone="primary" disabled={blocked()} style={box(6, 6, 60, 28)} onPress={() => typing() || saved() || p.s.mode() === "about" || p.s.choosing() ? p.s.dismiss() : p.s.openSearch()} />;
  const padView = <ClassicPanel ref={pad} debugName="MapTouchpad" active headerHeight={22} style={{ ...box(6, top(), 246, height()), opacity: blocked() ? 0.5 : 1, display: p.s.choosing() ? 1 : 0 }}>
    <Text class="absolute left-0 right-0 top-[4] text-xs text-center font-bold text-white">{naming() ? p.s.saved.editing() ? "Rename saved place" : "Save place to your Mac" : results() ? "Choose a place" : touching() ? "Moving map" : "Map touchpad"}</Text>
    <Show when={!typing()}>
      <Image src="map-pad.svg" style={box(99, 41, 48, 48)} />
      <Text class="absolute left-0 right-0 bottom-[23] text-center text-xs text-[#526981]">{results() ? "Slide to choose; tap to open" : "Drag to pan. Flick to glide."}</Text>
      <Text class="absolute left-0 right-0 bottom-[8] text-center text-xs text-[#8491a1]">{saved() ? `Page ${Math.floor((p.s.saved.page()?.offset ?? 0) / 5) + 1} of ${Math.max(1, Math.ceil((p.s.saved.page()?.total ?? 0) / 5))}   Left / Right: turn page` : results() ? "Or use D-pad and A" : "The upper screen follows your stylus"}</Text>
    </Show>
    <Show when={typing()}><Text class="absolute left-0 right-0 top-[32] text-xs text-center text-[#62758c]">{naming() ? p.s.saved.busy() ? "Saving on your Mac..." : p.s.saved.error() || "Name this location, then tap Save" : "Drag here to move the map"}</Text></Show>
  </ClassicPanel>;
  const plus = <ClassicButton debugName="ZoomIn" label={saved() ? "Prev" : "+"} surface="auxiliary" style={{ ...box(258, top(), 56, Math.floor((height() - 6) / 2)), display: p.s.choosing() ? 1 : 0 }} disabled={blocked() || naming() || (saved() ? !(p.s.saved.page()?.offset) : results())} onPress={() => saved() ? p.s.saved.turnPage(-1) : p.s.zoom(1)} />;
  const minus = <ClassicButton debugName="ZoomOut" label={saved() ? "Next" : "-"} surface="auxiliary" style={{ ...box(258, top() + Math.floor((height() - 6) / 2) + 6, 56, Math.floor((height() - 6) / 2)), display: p.s.choosing() ? 1 : 0 }} disabled={blocked() || naming() || (saved() ? !p.s.saved.page() || p.s.saved.page()!.offset + 5 >= p.s.saved.page()!.total : results())} onPress={() => saved() ? p.s.saved.turnPage(1) : p.s.zoom(-1)} />;
  const left = <ClassicButton debugName="PinButton" label={typing() ? "Clear" : saved() ? "Rename" : results() ? "Map" : "Back to pin"} surface="auxiliary" style={{ ...box(6, 200, 99, 34), display: p.s.choosing() ? 1 : 0 }} disabled={blocked() || saved() && !p.s.saved.selected() || !typing() && !results() && !p.s.pin()} onPress={() => naming() ? p.s.saved.changeName("") : typing() ? p.s.setQuery("") : saved() ? p.s.saved.begin(p.s.saved.selected()!, true) : results() ? p.s.dismiss() : p.s.go(p.s.pin())} />;
  const middle = <ClassicButton debugName="SaveButton" label={saved() ? "Delete" : results() ? "Save place" : "Save view"} surface="auxiliary" style={{ ...box(111, 200, 98, 34), display: typing() || p.s.choosing() ? 1 : 0 }} disabled={blocked() || results() && !p.s.rows().length} onPress={() => saved() ? p.s.saved.askRemove() : p.s.saveCurrent()} />;
  const right = <ClassicButton debugName="GoButton" label={naming() ? p.s.saved.busy() ? "Saving..." : p.s.saved.error() ? "Retry" : "Save" : typing() ? "Find" : results() ? "Go to place" : "Saved"} surface="auxiliary" tone="primary" style={{ ...box(typing() ? 111 : 215, 200, typing() ? 203 : 99, 34), display: p.s.choosing() ? 1 : 0 }} disabled={blocked() || results() && !p.s.rows().length || typing() && !(naming() ? p.s.saved.name() : p.s.query()).trim()} onPress={() => typing() ? p.s.key("GO") : results() ? p.s.go() : p.s.saved.open()} />;
  const sheet = <ClassicSheet debugName="DeleteSavedPlace" open={!!p.s.saved.deleting()} title="Delete saved place?" message={p.s.saved.error() || p.s.saved.deleting()?.name} surface="auxiliary" cancelLabel="Keep place" cancelDisabled={p.s.saved.busy()} onCancel={p.s.saved.cancelDelete} onModalChange={p.s.saved.setModal}
    actions={[{ get label() { return p.s.saved.busy() ? "Deleting..." : p.s.saved.error() ? "Retry delete" : "Delete place"; }, tone: "danger", get disabled() { return p.s.saved.busy(); }, onPress: p.s.saved.remove }]} />;
  return <AuxiliarySurface><View class="relative w-[320] h-[240] bg-[#d5dde7]">
    <View class="absolute left-0 top-0 w-full h-[38] bg-gradient-to-b from-[#eef3f9] to-[#b5c5d8]" />
    {search}
    <View class="absolute left-[72] top-[6] w-[242] h-[28] rounded-[5] border border-[#91a3ba] bg-white overflow-hidden" style={{ display: typing() || results() ? 0 : 1 }}>
      <Text class="absolute left-[7] top-[7] text-xs text-[#354d67]">{typing() ? `${(naming() ? p.s.saved.name() : p.s.query()).slice(-31)}|` : saved() ? "Saved on your paired Mac" : results() ? p.s.query().slice(0, 32) : p.s.localMapAvailable() && !p.s.online() ? "Hyrule on SD - Mac for search & saves" : p.s.online() ? p.s.planar() ? "Hyrule - Breath of the Wild" : "Explore with your Nintendo 3DS" : "Waiting for paired Mac"}</Text>
    </View>
    <ClassicButton debugName="MapSourceButton" label={p.s.switching() ? "Opening map..." : `Map: ${p.s.planar() ? "Hyrule" : "OpenStreetMap"}`} surface="auxiliary" style={{ ...box(72, 6, 242, 28), display: typing() || results() ? 1 : 0 }} disabled={blocked() || !p.s.maps().length} onPress={p.s.openSources} />
    <Show when={p.s.choosing()}><View style={box(6, 40, 308, 194)}>
      <For each={p.s.choices()}>{(name, i) => <ClassicButton label={name} surface="auxiliary" tone={p.s.selection() === i() ? "primary" : undefined} style={box(0, i() * 30, 308, 27)} onPress={() => p.s.choose(i())} />}</For>
      <ClassicButton label="Back to map" surface="auxiliary" style={box(0, 160, 308, 34)} onPress={p.s.dismiss} />
    </View></Show>
    {keyboard}{padView}{plus}{minus}{left}{middle}{right}{sheet}
  </View></AuxiliarySurface>;
}

export default function MapApp() {
  const s = createMapForHost(); (globalThis as unknown as { __map: MapModel }).__map = s;
  let marker: NodeMirror | undefined, bar: NodeMirror | undefined, scaleText: NodeMirror | undefined, zoomText: NodeMirror | undefined;
  onFrame(() => {
    const v = s.camera.view(), pin = s.pin();
    hot.text(zoomText, `z${v.zoom.toFixed(1)}`);
    if (pin) { const pos = worldPosition(pin); let dx = pos.x - v.x; if (!s.planar()) dx -= Math.round(dx / 256) * 256;
      hot.prop(marker, "translateX", 200 + dx * v.scale - 8); hot.prop(marker, "translateY", 120 + (pos.y - v.y) * v.scale - 22); }
    const scale = s.planar() ? { pixels: 64, label: `${Math.round(64 / v.scale * 24000 / 256)} u` } : scaleBar(unproject(v.x, v.y).lat, v.zoom);
    hot.prop(bar, "scaleX", scale.pixels / 70); hot.text(scaleText, scale.label);
  });
  const deck = <Deck s={s} />;
  const map = <View debugName="MapViewport" class="absolute left-0 top-0 w-[400] h-[240] overflow-hidden bg-[#e6e7de]">
    <TileLayer s={s} back /><TileLayer s={s} />
    <For each={s.annotations.renderRows()}>{marker => <Annotation s={s} marker={marker} />}</For>
    <Image ref={marker} src="map-pin.svg" style={{ ...box(0, 0, 16, 24), display: s.pin() ? 0 : 1 }} />
  </View>;
  return <><View class="relative w-[400] h-[240] bg-[#e6e7de]">
    {map}
    <View class="absolute left-0 top-0 w-full h-[25] bg-gradient-to-b from-[#f5f8fc] to-[#b7c9df]">
      <Image src="map-pad.svg" style={box(7, 3, 19, 19)} /><Text class="absolute left-[32] top-[5] text-sm font-bold text-[#294b70]">Pocket Map</Text>
      <View class="absolute right-[51] top-[9] w-[6] h-[6] rounded-full" style={{ bgColor: s.online() ? "#4d9e67" : "#b98347" }} />
      <Text ref={zoomText} class="absolute right-[4] top-[6] w-[40] h-[16] text-xs text-[#4c627a]">z14.0</Text>
    </View>
    <View class="absolute left-[6] bottom-[7] w-[82] h-[28] rounded-[3] bg-[#ffffffdd]">
      <Text ref={scaleText} class="absolute left-[5] top-[1] w-[70] h-[14] text-xs text-[#374c58]">500 m</Text>
      <View ref={bar} style={{ ...box(5, 19, 70, 3), bgColor: "#374c58", originX: -0.5 }} />
    </View>
    <Show when={(!s.online() && !s.localMapAvailable()) || !s.info() || s.switching()}><View class="absolute left-[86] top-[102] w-[228] h-[37] rounded-[5] border border-[#a4b2be] bg-[#fffffff0]">
      <Text class="absolute left-[6] right-[6] top-[12] text-xs text-center text-[#52667a]">{s.status().slice(0, 35)}</Text>
    </View></Show>
    <Show when={s.mode() === "name" && !s.saved.editing()}><View class="absolute left-[194] top-[114] w-[12] h-[12]">
      <View class="absolute left-[5] top-0 w-[2] h-[12] bg-[#275994]" /><View class="absolute left-0 top-[5] w-[12] h-[2] bg-[#275994]" />
    </View></Show>
    <SearchResults s={s} />
    <Show when={s.mode() === "about"}><ClassicPanel active style={box(24, 35, 352, 175)}>
      <Text class="absolute left-0 right-0 top-[7] text-xs text-center text-white font-bold">Pocket Map</Text>
      <Text class="absolute left-[14] top-[37] text-xs text-[#354d67]">{`Stylus / Circle Pad / D-pad: pan\n+ and -: zoom around the map center\nY: search   X: return to selected place\nHold L: places   Hold R: map controls\nHold ZL + Up/Down: zoom level\n\n${s.planar() ? "Hyrule: Breath of the Wild\nMap art: Nintendo | Data: Zelda Dungeon\nMap and place search stored on your Mac" : "Maps: OpenStreetMap contributors\nosm.org/copyright | Tiles: OSM DE\nPlace search: Photon by komoot"}`}</Text>
    </ClassicPanel></Show>
    <ChoicePanel s={s} /><Context s={s} /><ZoomRail s={s} />
    <View class="absolute right-0 bottom-0 h-[15] bg-[#ffffffee]" style={{ width: 235 }}><Text class="absolute right-[3] top-[1] text-xs text-[#35434b]">{s.info()?.attribution ?? "Map data"}</Text></View>
  </View>{deck}</>;
}
