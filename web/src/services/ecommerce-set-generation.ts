import i18n from "@/i18n";
import { assembleSlotPrompt, buildAnalysisInstruction, buildPlanInstruction, buildReviewInstruction, parseProductProfile, parsePromptPlan, parseReviewSlots } from "@/lib/ecommerce-set/prompt-plan";
import { referenceRoleLabel, slotDescriptor } from "@/lib/ecommerce-set/presets";
import { isReviewableSlot } from "@/lib/ecommerce-set/review";
import { compressForVisionReview } from "@/lib/image-compression";
import { requestEdit, requestImageQuestion, type AiTextMessage } from "@/services/api/image";
import { blobToDataUrl, getImageBlob, imageToDataUrl, uploadImage } from "@/services/image-storage";
import type { AiConfig } from "@/stores/use-config-store";
import type { EcommerceReview, EcommerceReviewSlot, EcommerceSetSlot, ProductProfile, ProductReference, ShotDescriptor } from "@/types/ecommerce-set";

/** Generated images are compressed only here, and only for the review request. */
const REVIEW_BATCH_MAX_BYTES = 12 * 1024 * 1024;
/** Keep room for request wrappers, model fields, and the configured system prompt. */
const REVIEW_REQUEST_RESERVE_BYTES = 64 * 1024;
const REVIEW_CONTENT_MAX_BYTES = REVIEW_BATCH_MAX_BYTES - REVIEW_REQUEST_RESERVE_BYTES;

const setText = (key: string, options?: Record<string, unknown>) => i18n.t(`ecommerceSet.${key}`, options);

type RequestOptions = { signal?: AbortSignal };
type ReviewContent = Exclude<AiTextMessage["content"], string>;
type ReviewItem = { shot: ShotDescriptor; dataUrl: string };

type PlanInput = {
    profile: ProductProfile;
    styleText: string;
    globalPrompt: string;
    avoidPrompt: string;
    shots: ShotDescriptor[];
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
    if (!input.shots.length) throw new Error(setText("errors.shotsRequired"));
    const instruction = buildPlanInstruction(input.profile, input.styleText, input.globalPrompt, input.avoidPrompt, input.shots);
    const answer = await requestImageQuestion(config, [{ role: "user", content: instruction }], () => {}, options);
    const plan = parsePromptPlan(answer, input.shots);
    const labels = new Map(input.shots.map((shot) => [shot.id, shot.label] as const));
    const prompts = plan.slots.map((slot) => ({
        id: slot.id,
        prompt: assembleSlotPrompt({
            profile: input.profile,
            styleText: input.styleText,
            globalPrompt: input.globalPrompt,
            avoidPrompt: input.avoidPrompt,
            globalConstraints: plan.globalConstraints,
            slot,
            label: labels.get(slot.id) || slot.id,
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
 * Review the whole set. References and generated images use temporary compressed copies that are never
 * written to `image_files` and are released when this call returns.
 */
export async function reviewSet(config: AiConfig, input: { references: ProductReference[]; slots: EcommerceSetSlot[]; profile?: ProductProfile }, options?: RequestOptions): Promise<EcommerceReview> {
    const reviewable = input.slots.filter(isReviewableSlot);
    if (!reviewable.length) throw new Error(setText("errors.noReviewableSlots"));

    const referenceUrls: string[] = [];
    for (const reference of input.references) {
        referenceUrls.push(await compressedReferenceDataUrl(reference));
    }

    // Compress every generated image first, so a compression failure blocks the review instead of
    // silently falling back to the uncompressed original.
    const compressed: ReviewItem[] = [];
    for (const slot of reviewable) {
        const shot = slotDescriptor(slot);
        const blob = await getImageBlob(slot.storageKey!);
        if (!blob) throw new Error(setText("errors.slotImageMissing", { slot: shot.label }));
        const review = await compressForVisionReview(blob);
        compressed.push({ shot, dataUrl: await blobToDataUrl(review.blob) });
    }

    const batches = splitReviewBatches(compressed, input, referenceUrls);
    const slots: EcommerceReviewSlot[] = [];
    const summaries: string[] = [];
    let requestBytes = 0;
    let batchesAttempted = 0;
    let failure: string | undefined;

    for (const batch of batches) {
        batchesAttempted += 1;
        const content = buildReviewContent(input, referenceUrls, batch, batches.length > 1);
        // Every batch re-uploads the references, so count what actually went out rather than the images alone.
        requestBytes += serializedBytes(content);
        try {
            const answer = await requestImageQuestion(config, [{ role: "user", content }], () => {}, options);
            const parsed = parseReviewSlots(
                answer,
                batch.map((item) => item.shot),
            );
            slots.push(...parsed.slots);
            if (parsed.summary) summaries.push(parsed.summary);
        } catch (error) {
            if (!slots.length) throw error;
            failure = error instanceof Error ? error.message : setText("errors.unknown");
            break;
        }
    }

    // Drop the compressed copies; they must not outlive the review task.
    compressed.length = 0;

    return {
        reviewedAt: Date.now(),
        status: failure ? "failed" : slots.some((slot) => slot.status === "manual_review") ? "manual_review" : "passed",
        summary: summaries.join("\n"),
        requestBytes,
        batches: batchesAttempted,
        slots,
        error: failure,
    };
}

/**
 * Split by serialized request content size. Each candidate batch is measured as the request that will
 * actually be sent, so the repeated compressed references and the per-shot review instruction lines are
 * both included instead of being estimated from the images alone.
 */
function splitReviewBatches(items: ReviewItem[], input: { references: ProductReference[]; profile?: ProductProfile }, referenceUrls: string[]) {
    const batches: Array<typeof items> = [];
    const emptyInstructionBytes = serializedBytes(buildReviewInstruction(input.profile, input.references.length, [], true));
    const baseContentBytes = serializedBytes(buildReviewContent(input, referenceUrls, [], true));
    let current: typeof items = [];
    let appendedContentBytes = 0;

    const batchBytes = (batch: ReviewItem[], appendedBytes: number) => {
        const instructionBytes = serializedBytes(
            buildReviewInstruction(
                input.profile,
                input.references.length,
                batch.map((item) => item.shot),
                true,
            ),
        );
        return baseContentBytes + appendedBytes + instructionBytes - emptyInstructionBytes;
    };

    for (const item of items) {
        // The base content already has one element, so appending this two-element fragment adds one
        // delimiter plus the fragment contents. Each multi-megabyte data URL is serialized only once.
        const fragmentBytes = serializedBytes(buildGeneratedReviewContent(item)) - 1;
        const candidate = [...current, item];
        const candidateContentBytes = appendedContentBytes + fragmentBytes;
        const candidateBytes = batchBytes(candidate, candidateContentBytes);
        if (candidateBytes <= REVIEW_CONTENT_MAX_BYTES) {
            current = candidate;
            appendedContentBytes = candidateContentBytes;
            continue;
        }
        if (!current.length) throw new Error(setText("errors.reviewRequestTooLarge"));
        batches.push(current);
        current = [item];
        appendedContentBytes = fragmentBytes;
        if (batchBytes(current, appendedContentBytes) > REVIEW_CONTENT_MAX_BYTES) throw new Error(setText("errors.reviewRequestTooLarge"));
    }
    if (current.length) batches.push(current);
    return batches;
}

function buildReviewContent(input: { references: ProductReference[]; profile?: ProductProfile }, referenceUrls: string[], batch: ReviewItem[], batched: boolean): ReviewContent {
    const content: AiTextMessage["content"] = [
        {
            type: "text",
            text: buildReviewInstruction(
                input.profile,
                input.references.length,
                batch.map((item) => item.shot),
                batched,
            ),
        },
    ];
    input.references.forEach((reference, index) => {
        content.push({ type: "text", text: setText("prompts.reviewReferenceLabel", { index: index + 1, role: referenceRoleLabel(reference.role) }) });
        content.push({ type: "image_url", image_url: { url: referenceUrls[index] } });
    });
    batch.forEach((item) => {
        content.push(...buildGeneratedReviewContent(item));
    });
    return content;
}

function buildGeneratedReviewContent(item: ReviewItem): ReviewContent {
    return [
        { type: "text", text: setText("prompts.reviewGeneratedLabel", { id: item.shot.id, role: item.shot.label }) },
        { type: "image_url", image_url: { url: item.dataUrl } },
    ];
}

function serializedBytes(value: unknown) {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Original, uncompressed data URL for a product reference. */
async function originalDataUrl(reference: ProductReference) {
    const url = await imageToDataUrl(reference);
    if (!url) throw new Error(i18n.t("apiErrors.referenceImageReadFailed"));
    return url;
}

async function compressedReferenceDataUrl(reference: ProductReference) {
    const stored = reference.storageKey ? await getImageBlob(reference.storageKey) : null;
    const source = stored || (await (await fetch(await originalDataUrl(reference))).blob());
    const compressed = await compressForVisionReview(source);
    return blobToDataUrl(compressed.blob);
}
