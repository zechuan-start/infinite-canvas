import i18n from "@/i18n";
import { assembleSlotPrompt, buildAnalysisInstruction, buildPlanInstruction, buildReviewInstruction, parseProductProfile, parsePromptPlan, parseReviewSlots } from "@/lib/ecommerce-set/prompt-plan";
import { referenceRoleLabel, shotRoleLabel } from "@/lib/ecommerce-set/presets";
import { isReviewableSlot } from "@/lib/ecommerce-set/review";
import { compressForVisionReview } from "@/lib/image-compression";
import { requestEdit, requestImageQuestion, type AiTextMessage } from "@/services/api/image";
import { blobToDataUrl, getImageBlob, imageToDataUrl, uploadImage } from "@/services/image-storage";
import type { AiConfig } from "@/stores/use-config-store";
import type { EcommerceReview, EcommerceReviewSlot, EcommerceSetSlot, EcommerceShotRole, ProductProfile, ProductReference } from "@/types/ecommerce-set";

/** Generated images are compressed only here, and only for the review request. */
const REVIEW_BATCH_MAX_BYTES = 12 * 1024 * 1024;
/** Keep room for request wrappers, model fields, and the configured system prompt. */
const REVIEW_REQUEST_RESERVE_BYTES = 64 * 1024;
const REVIEW_CONTENT_MAX_BYTES = REVIEW_BATCH_MAX_BYTES - REVIEW_REQUEST_RESERVE_BYTES;

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
    const reviewable = input.slots.filter(isReviewableSlot);
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

    const batches = splitReviewBatches(compressed, input, referenceUrls);
    const requestBytes = compressed.reduce((total, item) => total + item.bytes, 0);
    const slots: EcommerceReviewSlot[] = [];
    const summaries: string[] = [];

    for (const batch of batches) {
        const slotIds = batch.map((item) => item.id);
        const content = buildReviewContent(input, referenceUrls, batch, batches.length > 1);

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

/** Split by serialized request content size, including repeated original references and base64 data URLs. */
function splitReviewBatches(items: Array<{ id: EcommerceShotRole; dataUrl: string; bytes: number }>, input: { references: ProductReference[]; profile?: ProductProfile }, referenceUrls: string[]) {
    const batches: Array<typeof items> = [];
    let current: typeof items = [];
    for (const item of items) {
        const candidate = [...current, item];
        if (current.length && reviewContentBytes(input, referenceUrls, candidate) > REVIEW_CONTENT_MAX_BYTES) {
            batches.push(current);
            current = [];
        }
        current.push(item);
        if (reviewContentBytes(input, referenceUrls, current) > REVIEW_CONTENT_MAX_BYTES) {
            throw new Error(setText("errors.reviewRequestTooLarge"));
        }
    }
    if (current.length) batches.push(current);
    return batches;
}

function buildReviewContent(input: { references: ProductReference[]; profile?: ProductProfile }, referenceUrls: string[], batch: Array<{ id: EcommerceShotRole; dataUrl: string; bytes: number }>, batched: boolean): AiTextMessage["content"] {
    const slotIds = batch.map((item) => item.id);
    const content: AiTextMessage["content"] = [{ type: "text", text: buildReviewInstruction(input.profile, input.references.length, slotIds, batched) }];
    input.references.forEach((reference, index) => {
        content.push({ type: "text", text: setText("prompts.reviewReferenceLabel", { index: index + 1, role: referenceRoleLabel(reference.role) }) });
        content.push({ type: "image_url", image_url: { url: referenceUrls[index] } });
    });
    batch.forEach((item) => {
        content.push({ type: "text", text: setText("prompts.reviewGeneratedLabel", { id: item.id, role: shotRoleLabel(item.id) }) });
        content.push({ type: "image_url", image_url: { url: item.dataUrl } });
    });
    return content;
}

function reviewContentBytes(input: { references: ProductReference[]; profile?: ProductProfile }, referenceUrls: string[], batch: Array<{ id: EcommerceShotRole; dataUrl: string; bytes: number }>) {
    return new TextEncoder().encode(JSON.stringify(buildReviewContent(input, referenceUrls, batch, true))).byteLength;
}

/** Original, uncompressed data URL for a product reference. */
async function originalDataUrl(reference: ProductReference) {
    const url = await imageToDataUrl(reference);
    if (!url) throw new Error(i18n.t("apiErrors.referenceImageReadFailed"));
    return url;
}
