# Pocket Map architecture

## Ownership

**The 3DS guest has one JavaScript thread and no network or filesystem calls.**
Its state consists of a camera, two tile-layer descriptions, a bounded search
page, local keyboard text, saved-place pages and a selected place. Solid owns components and
subscriptions. Continuous camera movement writes paint transforms through
PocketJS `hot` APIs; a tile window change updates the component tree.

The native offload worker owns sockets, the SD pairing-key read and binary
reception. The paired Mac's capability process owns SQLite atlas reads, texture
decompression, HTTPS/MVT parsing, styling, simplification, polygon triangulation and Unicode label rasterization. Custom raster sources retain the PNG decoder.
Atlas preparation performs JPEG decoding and R5G6B5 packing before browsing.
Provider socket callbacks pass
bounded requests and replies; they do not execute these capabilities.

## Working set

| Budget | Limit |
| --- | --- |
| Active resource requests | 3 |
| Resource starts / materializations | 1 / 1 per frame |
| Tile collection | 40 entries, two view owners |
| Tile demand per view | 24 addresses (up to 12 visible + 12 local look-ahead; OSM extras capped at four) |
| Shared image / mesh staging | 8 × 131,088 bytes plus metadata |
| Native image envelope | 16–256px power-of-two sides, two bytes per pixel |
| Native image or mesh materializations | 1 per frame |
| Places per search | 5 |
| Saved places | 1,000 on Mac; four five-place pages cached on device |
| Saved-place name | 36 UTF-16 code units |
| Label resource cache | 40 windows; at most 12 demanded, 12 records per window (Hyrule demands at most four) |
| Query text | 80 UTF-16 code units |
| Unicode label collection | 24 × 256×32 images; at most 12 map labels visible |
| Mac concurrent tile decodes | 3 |
| Mac prepared geometry cache | 128 source tiles, honoring expiry |
| Native mesh entry | 4,096 vertices; 2,048 triangles; 36,880 wire bytes |
| Retained GPU geometry | 8 MiB including pending retirement; at most 196,608 bytes per mesh |
| Mac decoded-image cache | 128 immutable atlas textures; 64 HTTP renditions honoring expiry |
| Mac HTTP cache | 2,048 bounded responses in SQLite |
| Mac transport credit | Eight total executing requests, queued replies and blocked writes |

The image collection reserves 18 bytes per pixel plus 512 bytes per entry:
native staging, old-plus-new core/GPU storage, the tiled upload scratch buffer
and the serialized ticket. Forty steady resident 256px tiles account for
about 15 MiB of core R5G6B5 plus GPU RGBA8 pixels; native staging, upload scratch,
fonts, UI nodes and JavaScript use separate memory. This is an admission upper bound, not a claim that
every tile allocates that amount. JSON responses retain the 4,096-byte record
and 2,500-code-unit payload limits.

## One tile's lifecycle

1. The camera's viewport produces near-first tile coordinates. Hyrule adds up
   to 12 neighbors using a 256px margin and at most 512px directional lead; OSM
   adds at most four, with a 128px margin and lead cap. Prediction accumulates camera travel across gestures in constant space. A
   settled direction chooses a forward corridor. Three idle seconds preserve
   direction, followed by confidence decay. Sustained turns replace old intent.
   Hyrule also prepares at most six next-level tiles for five seconds after a
   zoom-in input, sharing the 12-extra-tile budget. Visible
   entries are pinned; extras have lower priority and are unpinned. Hyrule clips
   both axes; OSM wraps longitude and clips polar rows. Addresses include the
   provider source identity.
2. `createResourceView` declares desired keys. The collection merges both zoom
   layers' demand and reserves entry cost before starting an offload read.
3. The Mac looks up an already baked Hyrule texture in SQLite and decompresses
   it to exactly 131,072 bytes, or returns a decoded-cache hit. This provider has
   no HTTP path. The OSM provider reads or fetches an MVT using HTTP validators,
   decodes PBF, applies a bounded detail policy and prepares indexed geometry.
   Geometry at source z14 serves display levels through z18.
4. The 3DS worker receives binary pixels or geometry into a free native slot and publishes
   a small ticket. Socket reads pause when staging credit is exhausted.
5. The scheduler materializes one completed resource per frame. The native
   upload consumes no JS pixel or vertex array; `ResourceImage` or `ResourceMesh`
   replaces its fallback. Mesh materialization also uploads an immutable GPU
   buffer. Drawing submits a handle, transform and clip rectangle; eviction
   frees the buffer after the preceding GPU frame retires.
6. `releaseResponse` returns staging credit. Texture / mesh disposal waits until
   cache eviction or invalidation with value removal. A cancelled or late
   response also returns staging credit without an upload.

**Rendering a resource does not request it.** Demand, subscriptions and
ownership have different roles. An old zoom layer retains loaded resources
while the new layer demands current tiles. It never requests an unseen parent
pyramid or downloads a city in advance.

## Relay transport (pilot)

With `transport: "relay"` the four read paths of the lifecycle above
(`map.tile`, `map.mesh`, `map.markers`, `map.label`) are relay resources; the
collections, budgets and eviction are unchanged, only the loader differs.

| Piece | Offload (default) | Relay |
| --- | --- | --- |
| Identity | method + JSON payload, cache key `source/z/x/y` | `ResourceRef{kind, ns: map/<source>, key: z/x/y, rendition, revision}`; the cache key is the same string |
| Request | `requestImage` / `requestMesh` / `request`, one credit of eight | `resource.get` with `accept`, `maxObjectBytes` and the held `ifRevision`; six of eight request slots (two reserved for control) |
| Transfer | one 131,088-byte PIMG or PMSH record | three 65,536-byte chunks (raster), one chunk (mesh, markers, label); digest-checked, published once |
| Withdrawal | callback dropped; the reply still arrives and returns credit | `CANCEL` on the sideband; the provider answers `CANCELLED/none` unless the object already entered its send queue |
| Reconnect | every tile re-requested | every resident tile revalidated with `ifRevision`: `notModified`, about 1.1 KB per tile |
| Source change | host restart; new source hash | one namespace-scope `INVALIDATE`; in-flight replies stamped with the old revision are fenced (`RESYNC_REQUIRED`) and resident tiles refetch |
| Host process | `host/worker.ts` behind the offload provider | the same worker module behind `host/relay-host.ts` (`MapRelayAuthority`), TCP listener from `tools/relay-wire.ts` |

Namespace scope is the one invalidation the authority can send in one frame
for a moved source: key scope would need one frame per resident key it does not
know about, and revision scope names one concrete (key, revision). The guest
keeps drawing the stale tiles and refetches them.

## Transport recovery

**The Mac connection manager does not import the native canvas module.** It
starts the existing capability module with `isolation: "process"`, using Bun IPC
instead of a Web Worker. Socket loss, a process crash or a nine-second task
deadline ends that session. The old process is reaped before the next starts;
its replies cannot cross connection generations. SQLite mutations retain their
operation receipts across process replacement.

The device retains transmission credit after a sent request is cancelled or
times out, until its reply arrives or the session ends. The Mac pauses reads at
eight total executing requests, queued replies and blocked writes. While a
write waits for the socket to drain, other work can start within that shared
budget. The scheduler preserves a desired in-flight prefetch when transport
credit cannot admit its replacement. Slow image
transfer therefore cannot build a queue proportional to cancelled viewports.
Connection logs name socket failures, process exits and timed-out methods;
they omit query text and command payloads.

## Motion and recovery

`createTileCamera` stores level-zero coordinates and log2 zoom. Dragging applies
screen-space deltas at the current scale. `createDragFilter` filters cumulative
touch travel with a 1px hysteresis and up to 3px additional lag. Fast motion
reduces filtering; stationary frames settle release velocity. The 1.45 touchpad
gain maps that 4px input-space bound to 5.8px on the map. Circle Pad movement approaches a
velocity; release follows exponential inertia. Zoom runs an anchored 180ms
transition. The integrator gives matching held-input/fling distances at 30 and
60 Hz. Mercator projection is application code.

`camera.setWorld` validates and replaces zoom limits and world bounds when the
provider metadata arrives. It stops previous motion and clamps the camera
without replacing the camera object or resource owners. Hyrule uses a finite
256-unit square and zoom levels 0–7. Its source coordinates map through
`x = (east + 12000) / 24000 * 256` and
`y = (12000 - north) / 24000 * 256`. Search results and bookmarks use an explicit
planar position instead of treating game coordinates as latitude/longitude.

Tile positions are rebased near the viewport before reaching native float
transforms, including the nearest world copy at the date line. Tile enumeration
has a hard maximum; a mismatched old level cannot create an unbounded loop.

On connection-generation changes, pending reads are cancelled and current
demand is revalidated. Resident tiles remain visible. An explicit source change
clears tiles, because the old source is a different identity. Exhausted tile
retries have a visible error fallback and an R-menu retry action. Search errors
and empty results have distinct messages; editing and submitting retries a
query. Local camera and query changes never wait for responses.

## Framework additions

PocketJS receives binary image responses, native staging ownership, the
`releaseResponse` cache hook, `createOffloadImageCollection`, and the camera /
visible-window / look-ahead functions in `tile-viewport`, and `createDragFilter`
in `gesture`. There is no OSM, Photon, Mercator,
search-history or map-service policy inside the framework. These APIs can
support image pages, photo renditions or diagram tiles using different keys
and demand plans.

The image extension retains offload's authenticated LAN connection and JSON
control frames. It does not turn the older companion SVC socket API into a
worker API. Other native hosts still need to implement optional image staging
operations; an in-process iPhone provider is not part of this implementation.

## Saved-place commands

A fourth resource collection owns four five-place SQLite pages. Selection,
name editing, pagination and delete confirmation belong to the app controller.
**Writes bypass the resource cache.** `bookmarks.command` carries a bounded
operation ID and typed save / rename / remove payload. The Mac commits the
change and its receipt in one SQLite transaction. Repeating that operation ID
returns the stored result; using it with another payload is rejected. Receipts
remain after deletion, so delayed save retries cannot recreate deleted data.

The UI waits for confirmation before changing its saved list. Missing replies
leave a retry action which retains the operation ID. Cancellation of that UI
cannot roll back a completed Mac write. Successful writes invalidate saved
pages; deleting the last row of a page makes the provider return the preceding
populated page. User data lives in `places.sqlite`; HTTP-cache eviction never
touches it. Hyrule uses `.local/hyrule/places.sqlite`; the geographic provider
uses `.local/places.sqlite`. Existing geographic records migrate transactionally
to typed positions while preserving IDs and operation receipts. The Mac performs
all SQL work in its provider process.

## Atlas preparation and scope

The pinned source contains 1,365 JPEG tiles in six levels. Preparation subdivides
750px source tiles into 256px RGB565 renditions, producing 21,845 tiles in eight
levels and a 2,576-place SQLite FTS5 index. Deflate compression applies only to
Mac storage. The completed atlas replaces its destination atomically after all
levels and metadata have been written. Downloaded art and generated databases
remain outside Git; source attribution is retained in the app and README.

This app implements map browsing, place search and saved places. Hyrule is fully
installed on the paired Mac; new tiles still require the LAN connection. There
is no GPS, turn-by-turn routing or satellite layer. The optional geographic
provider has no area downloader, and public services have no availability
guarantee. Network isolation and bounded work do not establish a hardware
frame-time guarantee.

## Source selection and annotation resources

**Each request identifies its source.** `map.info({ kind })` returns the selected
metadata and the installed-source catalog. The worker routes tile/search and
bookmark calls by source identity rather than mutating a connection-wide active
provider. Delayed commands and retries therefore retain their original SQLite
database. Old guests that omit a source use the configured startup provider.

The guest suspends new resource starts while source metadata is requested. It
keeps old pixels visible until metadata succeeds, then cancels old demand,
clears source-dependent collections and restores that map's remembered camera.
Source changes are unavailable during bookmark naming or mutation confirmation.

The marker index uses SQLite R-tree queries on the Mac. Requests address fixed
512px annotation windows at an integer level and a category filter. Each reply
has at most 12 records; four windows cover the viewport. The host bounds query
candidates to 256 and chooses one marker per density grid slot. Region, travel,
enemy and collectible visibility use different zoom ranges. This reduces
clutter; it is not a full cross-window label-collision solver.

Annotation responses share resource scheduling with terrain but have separate
cache costs and view ownership. Names and category icons are drawn locally at
constant screen size; only their transforms change during motion. No bitmap is
requested for every label or every frame. Icon assets are compiled into the
package. An annotation cache failure leaves terrain navigation available.

The [vector map design](VECTOR_MAP.md) documents source selection, geometry format, label windows, GPU/CPU responsibilities and measured bandwidth.
