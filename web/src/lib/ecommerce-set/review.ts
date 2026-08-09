import type { EcommerceSetSlot } from "@/types/ecommerce-set";

/** Failed or stale originals remain downloadable but are not eligible for a new review. */
export function isReviewableSlot(slot: Pick<EcommerceSetSlot, "enabled" | "storageKey" | "status" | "stale">) {
    return slot.enabled && Boolean(slot.storageKey) && !slot.stale && slot.status !== "generation_failed";
}
