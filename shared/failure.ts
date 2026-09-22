import { RELAY_ERROR } from "@pocketjs/framework/relay/spec";

/** A capability failure that names the §3.6 error code a consumer acts on.
 * The message is diagnostics and may be translated; the code is the contract.
 * Draft §3.6: "error.code 决定可采取的动作 … 不依据英文 message 猜测". */
export class MapFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "MapFailure";
  }
}

/** The address, key or arguments cannot name a resource of this profile. */
export const invalid = (message: string) => new MapFailure(RELAY_ERROR.INVALID, message);
/** The resource is named correctly and the authority does not have it. */
export const notFound = (message: string) => new MapFailure(RELAY_ERROR.NOT_FOUND, message);
/** A bounded provider queue is full; the same request later succeeds. */
export const busy = (message: string) => new MapFailure(RELAY_ERROR.BUSY, message);
/** The profile does not define this operation for this source. */
export const unsupported = (message: string) => new MapFailure(RELAY_ERROR.UNSUPPORTED, message);
/** The object would exceed a declared byte budget. */
export const tooLarge = (message: string) => new MapFailure(RELAY_ERROR.TOO_LARGE, message);
/** The upstream service did not produce a usable result in time. */
export const upstream = (message: string) => new MapFailure(RELAY_ERROR.DEADLINE, message);

/** Every §3.6 code an authority may put on a get terminal. */
const CODES: ReadonlySet<string> = new Set(Object.values(RELAY_ERROR));

/** The code a failure declared, or the fallback for an unclassified fault.
 * DEADLINE is the fallback because a fault the provider never classified is
 * the one case where a later retry is the only sound guest action; a
 * permanent refusal always carries its own code. Nothing here reads the
 * message. */
export function failureCode(error: unknown, fallback: string = RELAY_ERROR.DEADLINE): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && CODES.has(code) ? code : fallback;
}

export function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
