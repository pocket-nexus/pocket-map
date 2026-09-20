import type { OffloadImage, OffloadMesh } from "@pocketjs/framework/offload/provider";
import { failureCode, failureMessage, invalid, unsupported } from "../shared/failure.ts";

export interface BackendRequest { id: number; method: string; payload: string; response?: "image" | "mesh" }
/** A relay backend failure names the §3.6 code; the message never selects
 * behaviour. */
export interface BackendError { code: string; message: string }
export interface BackendReply { id: number; payload?: string; error?: BackendError; image?: OffloadImage; mesh?: OffloadMesh }

/** The capabilities the relay host's offload worker keeps: saved places are
 * mutations and stay on offload (#437 pilot order). Every map read is a
 * relay resource there, so this worker cannot answer one from a
 * configuration the relay authority has replaced. */
export const SAVED_PLACES_ONLY = ["bookmarks.list", "bookmarks.command"] as const;

export type MapMethods = Readonly<Record<string, (payload: string) => string | OffloadImage | OffloadMesh | Promise<string | OffloadImage | OffloadMesh>>>;

/** Worker-side allowlist for the relay authority. It is the offload
 * dispatcher's sibling with two differences the relay path needs: the
 * failure keeps its declared error code, and a text reply is bounded by the
 * resource's maxObjectBytes rather than by the 2,500-character offload
 * record (a place search or the catalog exceeds that record). */
export async function dispatchMapCapability(methods: MapMethods, request: BackendRequest): Promise<BackendReply> {
  try {
    const handler = Object.prototype.hasOwnProperty.call(methods, request.method) ? methods[request.method] : undefined;
    if (!handler) throw unsupported("Capability not granted");
    const value = await handler(request.payload);
    if (typeof value === "string") {
      if (request.response !== undefined) throw invalid("Text reply for a binary resource");
      return { id: request.id, payload: value };
    }
    if ("format" in value && value.format === "mesh2d-v1") {
      if (request.response !== "mesh") throw invalid("Mesh response was not requested");
      return { id: request.id, mesh: value };
    }
    if (request.response !== "image") throw invalid("Image response was not requested");
    return { id: request.id, image: value as OffloadImage };
  } catch (error) {
    return { id: request.id, error: { code: failureCode(error), message: failureMessage(error).slice(0, 160) } };
  }
}
