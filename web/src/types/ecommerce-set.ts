import type { GenerationLogConfig, ReferenceImage } from "@/types/image";

export type EcommerceReferenceRole = "main" | "packaging" | "detail" | "size" | "other";
export type EcommerceShotRole = "hero" | "material" | "scene" | "feature" | "packaging" | "closing" | "custom";

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
    id: string;
    prompt: string;
    requiredElements: string[];
    avoidElements: string[];
};

/** What the planning and review models are told about one shot, keyed by the slot's unique id. */
export type ShotDescriptor = {
    id: string;
    role: EcommerceShotRole;
    label: string;
    brief: string;
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
    /** Unique within the set. Built-in shots use their role name; duplicated and custom shots get a generated id. */
    id: string;
    /** Shot type. Several slots may share a role, e.g. two scene shots. */
    role: EcommerceShotRole;
    /** Set only for custom or renamed shots; built-in shots fall back to the role label. */
    label?: string;
    /** Set only for custom shots; tells the planning model what this shot must deliver. */
    brief?: string;
    order: number;
    enabled: boolean;
    prompt: string;
    requiredElements: string[];
    avoidElements: string[];
    status: EcommerceSlotStatus;
    /** This slot was excluded from the latest plan and must be planned again before generation. */
    promptStale?: boolean;
    /** The saved original no longer matches the current prompt or plan, but remains downloadable until regenerated. */
    stale?: boolean;
    storageKey?: string;
    /** Fingerprint of the references the saved original was generated from; a mismatch means it is out of date. */
    referenceKey?: string;
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
    slotId: string;
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
    /** Serialized bytes of the review requests actually sent, including the references repeated in every batch. */
    requestBytes: number;
    /** Number of review requests used; more than one means the set was reviewed in batches. */
    batches: number;
    slots: EcommerceReviewSlot[];
    error?: string;
};
