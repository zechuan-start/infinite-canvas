import type { EcommerceReview, EcommerceSetSlot, EcommerceSetStatus, ProductProfile, ProductReference } from "@/types/ecommerce-set";

export type ReferenceImage = {
    id: string;
    name: string;
    type: string;
    dataUrl: string;
    url?: string;
    storageKey?: string;
};

export type GeneratedImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
};

/** Structurally matches Pick<AiConfig, "model" | "imageModel" | "quality" | "size" | "count">. */
export type GenerationLogConfig = {
    model: string;
    imageModel: string;
    quality: string;
    size: string;
    count: string;
};

export type SingleGenerationLog = {
    id: string;
    kind: "single";
    createdAt: number;
    updatedAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "success" | "failed";
    images: GeneratedImage[];
    thumbnails: string[];
};

export type EcommerceSetRecord = {
    id: string;
    kind: "ecommerce-set";
    createdAt: number;
    updatedAt: number;
    title: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    status: EcommerceSetStatus;
    /** Style preset id, or "custom" when the user wrote their own style description. */
    stylePresetId: string;
    customStyle: string;
    globalPrompt: string;
    avoidPrompt: string;
    references: ProductReference[];
    profile?: ProductProfile;
    globalConstraints: string[];
    slots: EcommerceSetSlot[];
    review?: EcommerceReview;
    durationMs: number;
    error?: string;
};

export type ImageGenerationRecord = SingleGenerationLog | EcommerceSetRecord;
