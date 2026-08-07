import i18n from "@/i18n";
import { assembleSlotPrompt, buildAnalysisInstruction, buildPlanInstruction, buildReviewInstruction, parseProductProfile, parsePromptPlan, parseReviewSlots } from "@/lib/ecommerce-set/prompt-plan";
import { referenceRoleLabel, shotRoleLabel } from "@/lib/ecommerce-set/presets";
import { compressForVisionReview } from "@/lib/image-compression";
import { requestEdit, requestImageQuestion, type AiTextMessage } from "@/services/api/image";
import { blobToDataUrl, getImageBlob, imageToDataUrl, uploadImage } from "@/services/image-storage";
import type { AiConfig } from "@/stores/use-config-store";
import type { EcommerceReview, EcommerceReviewSlot, EcommerceSetSlot, EcommerceShotRole, ProductProfile, ProductReference } from "@/types/ecommerce-set";

/** Generated images are compressed only here, and only for the review request. */
const REVIEW_BATCH_MAX_BYTES = 12 * 1024 * 1024;

const setText = (key: string, options?: Record<string, unknown>) => i18n.t(`ecommerceSet.${key}`, options);

type RequestOptions = { signal?: AbortSignal };

type PlanInput = {
    profile: ProductProfile;
    styleText: string;
    globalPrompt: string;
    avoidPrompt: string;
    slotIds: EcommerceShotRole[];
};

export type GeneratedSlotImage = {
    storageKey: string;
    url: string;
    naturalWidth: number;
    naturalHeight: number;
    bytes: number;
    mimeType: string;
    durationMs: number;
};

/** Ask the vision model to describe the product from the untouched original references. */
export async function analyzeProduct(config: AiConfig, references: ProductReference[], options?: RequestOptions): Promise<ProductProfile> {
    if (!references.length) throw new Error(setText("errors.referencesRequired"));
    const content: AiTextMessage["content"] = [{ type: "text", text: buildAnalysisInstruction(references) }];
    for (const reference of references) {
        content.push({ type: "image_url", image_url: { url: await originalDataUrl(reference) } });
    }
    const answer = await requestImageQuestion(config, [{ role: "user", content }], () => {}, options);
    return parseProductProfile(answer);
}

/** Plan the shot layer, then assemble each slot's full three-layer prompt locally. */
export async function planSlotPrompts(config: AiConfig, input: PlanInput, options?: RequestOptions) {
    if (!input.slotIds.length) throw new Error(setText("errors.shotsRequired"));
    const instruction = buildPlanInstruction(input.profile, input.styleText, input.globalPrompt, input.avoidPrompt, input.slotIds);
    const answer = await requestImageQuestion(config, [{ role: "user", content: instruction }], () => {}, options);
    const plan = parsePromptPlan(answer, input.slotIds);
    const prompts = plan.slots.map((slot) => ({
        id: slot.id,
        prompt: assembleSlotPrompt({
            profile: input.profile,
            styleText: input.styleText,
            globalPrompt: input.globalPrompt,
            avoidPrompt: input.avoidPrompt,
            globalConstraints: plan.globalConstraints,
            slot,
        }),
        requiredElements: slot.requiredElements,
        avoidElements: slot.avoidElements,
    }));
    return { globalConstraints: plan.globalConstraints, prompts };
}

/**
 * Generate one shot with `count = 1`, save the untouched original immediately and return metadata only.
 * The caller never holds the full base64 image, so a six-shot set does not sit in React state.
 */
export async function generateSlotImage(config: AiConfig, prompt: string, references: ProductReference[], options?: RequestOptions): Promise<GeneratedSlotImage> {
    const startedAt = performance.now();
    const result = await requestEdit({ ...config, count: "1" }, prompt, references, undefined, options);
    const image = result[0];
    if (!image) throw new Error(i18n.t("imageWorkbench.missingResult"));
    const stored = await uploadImage(image.dataUrl);
    return {
        storageKey: stored.storageKey,
        url: stored.url,
        naturalWidth: stored.width,
        naturalHeight: stored.height,
        bytes: stored.bytes,
        mimeType: stored.mimeType,
        durationMs: performance.now() - startedAt,
    };
}

/**
 * Review the whole set. Product references go up as originals; generated images go up as temporary
 * compressed copies that are never written to `image_files` and are released when this call returns.
 */
export async function reviewSet(config: AiConfig, input: { references: ProductReference[]; slots: EcommerceSetSlot[]; profile?: ProductProfile }, options?: RequestOptions): Promise<EcommerceReview> {
    const reviewable = input.slots.filter((slot) => slot.storageKey && slot.status !== "generation_failed");
    if (!reviewable.length) throw new Error(setText("errors.noReviewableSlots"));

    const referenceUrls: string[] = [];
    for (const reference of input.references) {
        referenceUrls.push(await originalDataUrl(reference));
    }

    // Compress every generated image first, so a compression failure blocks the review instead of
    // silently falling back to the uncompressed original.
    const compressed: Array<{ id: EcommerceShotRole; dataUrl: string; bytes: number }> = [];
    for (const slot of reviewable) {
        const blob = await getImageBlob(slot.storageKey!);
        if (!blob) throw new Error(setText("errors.slotImageMissing", { slot: shotRoleLabel(slot.id) }));
        const review = await compressForVisionReview(blob);
        compressed.push({ id: slot.id, dataUrl: await blobToDataUrl(review.blob), bytes: review.bytes });
    }

    const batches = splitReviewBatches(compressed);
    const requestBytes = compressed.reduce((total, item) => total + item.bytes, 0);
    const slots: EcommerceReviewSlot[] = [];
    const summaries: string[] = [];

    for (const batch of batches) {
        const slotIds = batch.map((item) => item.id);
        const content: AiTextMessage["content"] = [{ type: "text", text: buildReviewInstruction(input.profile, input.references.length, slotIds, batches.length > 1) }];
        input.references.forEach((reference, index) => {
            content.push({ type: "text", text: setText("prompts.reviewReferenceLabel", { index: index + 1, role: referenceRoleLabel(reference.role) }) });
            content.push({ type: "image_url", image_url: { url: referenceUrls[index] } });
        });
        batch.forEach((item) => {
            content.push({ type: "text", text: setText("prompts.reviewGeneratedLabel", { id: item.id, role: shotRoleLabel(item.id) }) });
            content.push({ type: "image_url", image_url: { url: item.dataUrl } });
        });

        const answer = await requestImageQuestion(config, [{ role: "user", content }], () => {}, options);
        const parsed = parseReviewSlots(answer, slotIds);
        slots.push(...parsed.slots);
        if (parsed.summary) summaries.push(parsed.summary);
    }

    // Drop the compressed copies; they must not outlive the review task.
    compressed.length = 0;

    return {
        reviewedAt: Date.now(),
        status: slots.some((slot) => slot.status === "manual_review") ? "manual_review" : "passed",
        summary: summaries.join("\n"),
        requestBytes,
        batches: batches.length,
        slots,
    };
}

/** Split by compressed payload size so one oversized request never silently drops images. */
function splitReviewBatches<T extends { bytes: number }>(items: T[]) {
    const batches: T[][] = [];
    let current: T[] = [];
    let currentBytes = 0;
    for (const item of items) {
        if (current.length && currentBytes + item.bytes > REVIEW_BATCH_MAX_BYTES) {
            batches.push(current);
            current = [];
            currentBytes = 0;
        }
        current.push(item);
        currentBytes += item.bytes;
    }
    if (current.length) batches.push(current);
    return batches;
}

/** Original, uncompressed data URL for a product reference. */
async function originalDataUrl(reference: ProductReference) {
    const url = await imageToDataUrl(reference);
    if (!url) throw new Error(i18n.t("apiErrors.referenceImageReadFailed"));
    return url;
}
