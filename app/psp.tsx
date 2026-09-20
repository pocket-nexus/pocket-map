import { createEffect, untrack, For, Show } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import {
  Image,
  Text,
  View,
  type NodeMirror,
} from "@pocketjs/framework/components";
import { ClassicFace, ClassicPanel } from "@pocketjs/framework/classic";
import { ResourceImage } from "@pocketjs/framework/resource";
import { createResourceView } from "@pocketjs/framework/resource-view";
import type { Place } from "../shared/types.ts";
import { createOsk, Osk } from "@pocketjs/framework/osk";
import { onFrame, onButtonPress } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import * as hot from "@pocketjs/framework/hot";
import { MENU, type MapModel } from "./model.ts";
import { createMapForHost } from "./transport.ts";
import { TileLayer, Annotation } from "./map-view.tsx";
import { worldPosition } from "./geo.ts";
const box = (x: number, y: number, w: number, h: number) => ({
  posType: 1,
  insetL: x,
  insetT: y,
  width: w,
  height: h,
});
function RowLabel(p: {
  s: MapModel;
  place: () => Place | undefined;
  title: () => string;
  selected: () => boolean;
}) {
  const unicode = () => !!p.place() && /[^\x20-\x7e]/.test(p.place()!.name);
  const image = createResourceView(p.s.labels, {
    demand: () =>
      unicode() ? [{ input: p.place()!, priority: -5, pin: true }] : [],
  });
  return (
    <Show
      when={unicode()}
      fallback={
        <Text
          class="absolute left-[10] text-xs"
          style={{
            insetT: p.s.listing() ? 8 : 4,
            textColor: p.selected() ? "#ffffff" : "#304f78",
          }}
        >
          {p.title().slice(0, 45)}
        </Text>
      }
    >
      <ResourceImage
        style={box(10, 0, 256, 32)}
        state={() => image.state(p.place()!)}
        fallback={() => (
          <View class="absolute left-[10] top-[9] w-[160] h-[8] bg-[#cbd5de] animate-pulse" />
        )}
      />
    </Show>
  );
}
export function PspMapApp() {
  const s = createMapForHost({ width: 480, height: 272 }, 24);
  (globalThis as unknown as { __map: typeof s }).__map = s;
  const osk = createOsk({
    value: () => (s.mode() === "name" ? s.saved.name() : s.query()),
    setValue: (text) =>
      s.mode() === "name" ? s.saved.changeName(text) : s.setQuery(text),
    maxLength: 36,
    closeOnCommit: false,
    onCommit: () => s.key("GO"),
    onClose: s.dismiss,
  });
  createEffect(() => {
    if (s.typing()) untrack(osk.open);
    else osk.close();
  });
  createEffect(() => s.saved.setModal(!!s.saved.deleting()));
  onButtonPress(BTN.SQUARE, () => {
    if (s.mode() === "saved" && !s.menu() && !s.saved.modal())
      s.saved.askRemove();
  });
  onButtonPress(BTN.CIRCLE, () => {
    if (s.saved.deleting() && !s.saved.busy()) s.saved.remove();
  });
  onButtonPress(BTN.START, () => {
    if (s.mode() === "name") {
      osk.open();
      return;
    }
    if (s.mode() === "saved" && s.saved.selected())
      s.saved.begin(s.saved.selected()!, true);
    else if (s.listing() || s.mode() === "map") s.saveCurrent();
  });
  let marker: NodeMirror | undefined, zoom: NodeMirror | undefined;
  onFrame(() => {
    const v = s.camera.view();
    hot.text(zoom, `z${v.zoom.toFixed(1)}`);
    const pin = s.pin();
    if (pin) {
      const p = worldPosition(pin);
      let dx = p.x - v.x;
      if (!s.planar()) dx -= Math.round(dx / 256) * 256;
      hot.prop(marker, "translateX", 240 + dx * v.scale - 8);
      hot.prop(marker, "translateY", 136 + (p.y - v.y) * v.scale - 22);
    }
  });
  const rows = () =>
    s.menu()
      ? MENU[s.menu()!]
      : s.choosing()
        ? s.choices()
        : s.rows().map((p) => p.name);
  const selected = () =>
    s.menu() ? s.menuIndex() : s.choosing() ? s.selection() : s.selectedIndex();
  const empty = () =>
    s.mode() === "saved"
      ? s.saved.state().status === "pending"
        ? "Loading saved places..."
        : s.saved.state().status === "error"
          ? "Saved places unavailable. Reopen to retry."
          : "No saved places. START saves this view."
      : s.submitted() && s.results.state(s.submitted()!).status === "pending"
        ? "Searching places on your Mac..."
        : s.submitted() && s.results.state(s.submitted()!).status === "error"
          ? "Search unavailable. Triangle edits the query."
          : "No places found. Triangle tries another query.";
  const title = () =>
    s.menu() === "places"
      ? "Places"
      : s.menu() === "map"
        ? "Map controls"
        : s.choosing()
          ? s.mode() === "sources"
            ? "Choose map"
            : "Map labels"
          : s.mode() === "saved"
            ? "Saved on your Mac"
            : `Places: ${s.query()}`;
  // Build each bounded subtree before mounting the outer screen on QuickJS.
  const tiles = (
    <View
      debugName="MapViewport"
      style={{ ...box(0, 0, 480, 272), overflow: 1, bgColor: "#e6e7de" }}
    >
      <TileLayer s={s} back />
      <TileLayer s={s} />
      <For each={s.annotations.renderRows()}>
        {(marker) => <Annotation s={s} marker={marker} />}
      </For>
      <Image
        ref={marker}
        src="map-pin.svg"
        style={{ ...box(0, 0, 16, 24), display: s.pin() ? 0 : 1 }}
      />
    </View>
  );
  const panel = (
    <Show when={s.menu() || s.choosing() || s.listing()}>
      <ClassicPanel active style={box(60, 31, 360, 211)}>
        <Text class="absolute left-[12] top-[6] text-xs font-bold text-white">
          {title().slice(0, 44)}
        </Text>
        <For each={rows()}>
          {(row, i) => (
            <ClassicFace
              selected={selected() === i()}
              style={box(
                8,
                30 + i() * (s.listing() ? 31 : 23),
                344,
                s.listing() ? 29 : 21,
              )}
            >
              <RowLabel
                s={s}
                place={() => (s.listing() ? s.rows()[i()] : undefined)}
                title={() => row}
                selected={() => selected() === i()}
              />
            </ClassicFace>
          )}
        </For>
        <Show when={!rows().length}>
          <Text class="absolute left-[12] top-[65] text-xs text-[#536b84]">
            {empty()}
          </Text>
        </Show>
        <Text class="absolute left-[12] bottom-[5] text-xs text-[#536b84]">
          {s.mode() === "saved"
            ? "O: open  START: rename  Square: delete  X: map"
            : "D-pad: choose   O: open   X: map"}
        </Text>
      </ClassicPanel>
    </Show>
  );
  const keyboard = (
    <Show when={s.typing()}>
      <View class="flex-col bg-[#e7ebf0]" style={box(0, 132, 480, 140)}>
        <View class="relative h-[28] shrink-0 bg-white">
          <Text class="absolute left-[10] top-[8] text-xs text-[#294b70]">
            {s.mode() === "name" ? "Save: " : "Search: "}
            {osk.display().slice(-52)}
          </Text>
        </View>
        <Osk osk={osk} theme="light" />
        <Text class="h-[20] text-xs text-center text-[#536b84]">
          {s.saved.busy()
            ? "Saving on your Mac..."
            : s.saved.error() ||
              "D-pad + O: type   Square: delete   Triangle: space   START: submit"}
        </Text>
      </View>
    </Show>
  );
  return (
    <View class="relative w-[480] h-[272] bg-[#e6e7de]">
      {tiles}
      <View class="absolute left-0 top-0 w-full h-[25] bg-gradient-to-b from-[#f5f8fc] to-[#b7c9df]">
        <Image src="map-pad.svg" style={box(7, 3, 19, 19)} />
        <Text class="absolute left-[32] top-[5] text-sm font-bold text-[#294b70]">
          Pocket Map
        </Text>
        <Text class="absolute right-[52] top-[7] text-xs text-[#4c627a]">
          {s.online() ? "USB / PSPLINK" : "Mac disconnected"}
        </Text>
        <Text
          ref={zoom}
          class="absolute right-[5] top-[7] text-xs text-[#4c627a]"
        >
          z14.0
        </Text>
      </View>
      <View class="absolute left-0 bottom-0 w-full h-[30] bg-[#f5f8f3]">
        <Text class="absolute left-[6] top-[3] text-xs text-[#4c627a]">
          Analog: pan L: places R: zoom / map Triangle: search
        </Text>
        <Text class="absolute left-[6] top-[17] text-xs text-[#65705f]">
          {s.info()?.attribution || s.status()}
        </Text>
      </View>
      {panel}
      <Show when={s.mode() === "about"}>
        <ClassicPanel active style={box(48, 42, 384, 180)}>
          <Text class="absolute left-[12] top-[6] text-xs font-bold text-white">
            Pocket Map / PSP
          </Text>
          <Text class="absolute left-[12] top-[40] right-[12] text-sm text-[#304f78]">
            Move with the analog stick or D-pad. Hold L for places, R for zoom
            and map settings. Choose with D-pad and O. Triangle searches. START
            saves a place; in Saved it renames. Left/right turns saved pages.
            SELECT recalibrates the resting stick. X returns to the map.
          </Text>
        </ClassicPanel>
      </Show>
      <Show when={s.saved.deleting()}>
        <ClassicPanel active style={box(60, 72, 360, 132)}>
          <Text class="absolute left-[12] top-[6] text-xs font-bold text-white">
            Delete saved place?
          </Text>
          <Text class="absolute left-[12] top-[42] text-sm text-[#304f78]">
            {s.saved.deleting()?.name}
          </Text>
          <Text class="absolute left-[12] top-[82] text-xs text-[#536b84]">
            {s.saved.busy()
              ? "Deleting on your Mac..."
              : s.saved.error() || "O: delete   X: keep place"}
          </Text>
        </ClassicPanel>
      </Show>
      {keyboard}
    </View>
  );
}
mount(() => <PspMapApp />);
