import type { GenerationLogConfig, ReferenceImage } from "@/types/image";

export type EcommerceReferenceRole = "main" | "packaging" | "detail" | "size" | "other";
export type EcommerceShotRole = "hero" | "material" | "scene" | "feature" | "packaging" | "closing";

/** Product reference image: a normal reference image plus the role the user assigned to it. */
export type ProductReference = ReferenceImage & { role: EcommerceReferenceRole };

export type ProductProfile = {
    productName: string;
    category: string;
    shape: string;
    materials: string[];
    colors: string[];
    surfaceDetails: string[];
    packagingDetails: string[];
    visibleText: string[];
    mustKeep: string[];
    mustAvoid: string[];
    usageNotes: string[];
};

/** Raw shot layer returned by the planning model, before the product and style layers are prepended. */
export type PromptPlanSlot = {
    id: EcommerceShotRole;
    prompt: string;
    requiredElements: string[];
    avoidElements: string[];
};

export type PromptPlan = {
    globalConstraints: string[];
    slots: PromptPlanSlot[];
};

export type EcommerceSetStatus = "draft" | "analyzing" | "planning" | "prompt_ready" | "generating" | "generated" | "reviewing" | "reviewed" | "partial" | "failed" | "cancelled";

export type EcommerceSlotStatus = "pending" | "generating" | "generated" | "generation_failed" | "review_pending" | "passed" | "manual_review";

/**
 * One shot of the set. `prompt` is the full three-layer prompt and the only text sent to the image model,
 * so editing it here changes the request. `storageKey` always points at the untouched generated original.
 */
export type EcommerceSetSlot = {
    id: EcommerceShotRole;
    order: number;
    enabled: boolean;
    prompt: string;
    requiredElements: string[];
    avoidElements: string[];
    status: EcommerceSlotStatus;
    storageKey?: string;
    /** Transient object URL for preview; never persisted. */
    url?: string;
    naturalWidth?: number;
    naturalHeight?: number;
    bytes?: number;
    mimeType?: string;
    durationMs?: number;
    /** Exact image-model parameters used for this saved original. */
    generationConfig?: GenerationLogConfig;
    error?: string;
    attempts: number;
};

export type EcommerceReviewSlot = {
    slotId: EcommerceShotRole;
    status: "passed" | "manual_review";
    confidence?: number;
    checks: {
        productConsistency: boolean;
        materialAccuracy: boolean;
        composition: boolean;
        textAccuracy: boolean;
    };
    issues: string[];
};

export type EcommerceReview = {
    reviewedAt: number;
    status: "passed" | "manual_review" | "failed";
    summary: string;
    /** Total bytes of the compressed generated images actually uploaded for this review. */
    requestBytes: number;
    /** Number of review requests used; more than one means the set was reviewed in batches. */
    batches: number;
    slots: EcommerceReviewSlot[];
    error?: string;
};
