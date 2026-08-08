import type { EcommerceSetSlot } from "@/types/ecommerce-set";

/** A failed latest generation is not eligible for a new review while its previous original remains downloadable. */
export function isReviewableSlot(slot: Pick<EcommerceSetSlot, "enabled" | "storageKey" | "status">) {
    return slot.enabled && Boolean(slot.storageKey) && slot.status !== "generation_failed";
}
