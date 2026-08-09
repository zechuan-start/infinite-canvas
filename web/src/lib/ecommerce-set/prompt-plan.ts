import i18n from "@/i18n";
import { referenceRoleLabel } from "@/lib/ecommerce-set/presets";
import type { EcommerceReviewSlot, ProductProfile, ProductReference, PromptPlan, PromptPlanSlot, ShotDescriptor } from "@/types/ecommerce-set";

const setText = (key: string, options?: Record<string, unknown>) => i18n.t(`ecommerceSet.${key}`, options);
const REVIEW_FEEDBACK_START = "<review_feedback>";
const REVIEW_FEEDBACK_END = "</review_feedback>";

/** Model-facing output language, so generated prompts and summaries follow the UI language. */
function outputLanguage() {
    return i18n.resolvedLanguage === "en-US" ? "English" : "简体中文";
}

/** Pull the JSON object out of a streamed text answer that may carry code fences or prose. */
export function parseJsonObject(text: string): Record<string, unknown> {
    const stripped = text.replace(/```[a-z]*\n?/gi, "").trim();
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error(setText("errors.jsonMissing"));
    try {
        const parsed = JSON.parse(stripped.slice(start, end + 1));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(setText("errors.jsonMissing"));
        return parsed as Record<string, unknown>;
    } catch (error) {
        throw new Error(error instanceof Error && error.message === setText("errors.jsonMissing") ? error.message : setText("errors.jsonInvalid"));
    }
}

function stringField(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown) {
    if (!Array.isArray(value)) return [];
    return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

/** Required product-profile fields; a missing one means the analysis is unusable, not silently empty. */
const REQUIRED_PROFILE_FIELDS = ["productName", "category", "shape"] as const;

export function parseProductProfile(text: string): ProductProfile {
    const raw = parseJsonObject(text);
    const profile: ProductProfile = {
        productName: stringField(raw.productName),
        category: stringField(raw.category),
        shape: stringField(raw.shape),
        materials: stringArray(raw.materials),
        colors: stringArray(raw.colors),
        surfaceDetails: stringArray(raw.surfaceDetails),
        packagingDetails: stringArray(raw.packagingDetails),
        visibleText: stringArray(raw.visibleText),
        mustKeep: stringArray(raw.mustKeep),
        mustAvoid: stringArray(raw.mustAvoid),
        usageNotes: stringArray(raw.usageNotes),
    };
    const missing = REQUIRED_PROFILE_FIELDS.filter((field) => !profile[field]);
    if (missing.length) throw new Error(setText("errors.profileIncomplete", { fields: missing.join(", ") }));
    if (!profile.mustKeep.length) throw new Error(setText("errors.profileIncomplete", { fields: "mustKeep" }));
    return profile;
}

/** Validate the plan against the shots actually requested: same count, unique ids, non-empty prompts. */
export function parsePromptPlan(text: string, requested: ShotDescriptor[]): PromptPlan {
    const raw = parseJsonObject(text);
    const rawSlots = Array.isArray(raw.slots) ? raw.slots : [];
    const byId = new Map(requested.map((shot) => [shot.id, shot] as const));
    const seen = new Set<string>();
    const slots: PromptPlanSlot[] = [];

    for (const item of rawSlots) {
        if (!item || typeof item !== "object") continue;
        const entry = item as Record<string, unknown>;
        const id = stringField(entry.id);
        const shot = byId.get(id);
        if (!shot || seen.has(id)) continue;
        const prompt = stringField(entry.prompt);
        if (!prompt) throw new Error(setText("errors.slotPromptMissing", { slot: shot.label }));
        seen.add(id);
        slots.push({ id, prompt, requiredElements: stringArray(entry.requiredElements), avoidElements: stringArray(entry.avoidElements) });
    }

    const missing = requested.filter((shot) => !seen.has(shot.id));
    if (missing.length) throw new Error(setText("errors.planIncomplete", { shots: missing.map((shot) => shot.label).join(", ") }));

    return {
        globalConstraints: stringArray(raw.globalConstraints),
        slots: requested.map((shot) => slots.find((slot) => slot.id === shot.id)!),
    };
}

export function parseReviewSlots(text: string, reviewed: ShotDescriptor[]) {
    const raw = parseJsonObject(text);
    const rawSlots = Array.isArray(raw.slots) ? raw.slots : [];
    const slots: EcommerceReviewSlot[] = [];

    for (const shot of reviewed) {
        const id = shot.id;
        const entry = rawSlots.find((item) => item && typeof item === "object" && stringField((item as Record<string, unknown>).slotId) === id) as Record<string, unknown> | undefined;
        if (!entry) throw new Error(setText("errors.reviewSlotMissing", { slot: shot.label }));
        const checks = (entry.checks && typeof entry.checks === "object" ? entry.checks : {}) as Record<string, unknown>;
        const issues = stringArray(entry.issues);
        const status = stringField(entry.status) === "passed" ? "passed" : "manual_review";
        const confidence = typeof entry.confidence === "number" && Number.isFinite(entry.confidence) ? entry.confidence : undefined;
        slots.push({
            slotId: id,
            status,
            confidence,
            checks: {
                productConsistency: checks.productConsistency === true,
                materialAccuracy: checks.materialAccuracy === true,
                composition: checks.composition === true,
                textAccuracy: checks.textAccuracy === true,
            },
            issues,
        });
    }

    return { summary: stringField(raw.summary), slots };
}

/** Analysis instruction: separate observed facts from guesses, and never invent product details. */
export function buildAnalysisInstruction(references: ProductReference[]) {
    const list = references.map((item, index) => setText("prompts.referenceLine", { index: index + 1, role: referenceRoleLabel(item.role), name: item.name })).join("\n");
    return [setText("prompts.analysisIntro"), list, setText("prompts.analysisRules"), setText("prompts.outputLanguage", { language: outputLanguage() }), setText("prompts.analysisSchema")].filter(Boolean).join("\n\n");
}

/** Planning instruction: the model only writes the shot layer; product and style layers are added locally. */
export function buildPlanInstruction(profile: ProductProfile, styleText: string, globalPrompt: string, avoidPrompt: string, shotList: ShotDescriptor[]) {
    const shots = shotList.map((shot, index) => setText("prompts.shotLine", { index: index + 1, id: shot.id, role: shot.label, brief: shot.brief })).join("\n");
    return [
        setText("prompts.planIntro", { count: shotList.length }),
        productConstraintText(profile),
        styleText ? setText("prompts.planStyle", { style: styleText }) : "",
        globalPrompt.trim() ? setText("prompts.planGlobal", { text: globalPrompt.trim() }) : "",
        avoidPrompt.trim() ? setText("prompts.planAvoid", { text: avoidPrompt.trim() }) : "",
        setText("prompts.planShots"),
        shots,
        setText("prompts.planRules"),
        setText("prompts.outputLanguage", { language: outputLanguage() }),
        setText("prompts.planSchema"),
    ]
        .filter(Boolean)
        .join("\n\n");
}

/** Fixed review rules; the model may only judge, never trigger a regeneration. */
export function buildReviewInstruction(profile: ProductProfile | undefined, referenceCount: number, shotList: ShotDescriptor[], batched: boolean) {
    const shots = shotList.map((shot, index) => setText("prompts.reviewShotLine", { index: index + 1, id: shot.id, role: shot.label })).join("\n");
    return [
        setText("prompts.reviewIntro", { references: referenceCount, generated: shotList.length }),
        batched ? setText("prompts.reviewBatched") : "",
        profile ? productConstraintText(profile) : "",
        setText("prompts.reviewShots"),
        shots,
        setText("prompts.reviewRules"),
        setText("prompts.outputLanguage", { language: outputLanguage() }),
        setText("prompts.reviewSchema"),
    ]
        .filter(Boolean)
        .join("\n\n");
}

function profileLine(labelKey: string, value: string | string[]) {
    const text = Array.isArray(value) ? value.filter(Boolean).join(", ") : value.trim();
    return text ? setText("prompts.profileLine", { label: setText(`profileFields.${labelKey}`), value: text }) : "";
}

/** Layer 1 of every shot prompt: what must stay true about the product. */
export function productConstraintText(profile: ProductProfile) {
    return [
        setText("prompts.productHeading"),
        profileLine("productName", profile.productName),
        profileLine("category", profile.category),
        profileLine("shape", profile.shape),
        profileLine("materials", profile.materials),
        profileLine("colors", profile.colors),
        profileLine("surfaceDetails", profile.surfaceDetails),
        profileLine("packagingDetails", profile.packagingDetails),
        profileLine("visibleText", profile.visibleText),
        profileLine("mustKeep", profile.mustKeep),
        profileLine("mustAvoid", profile.mustAvoid),
        profileLine("usageNotes", profile.usageNotes),
    ]
        .filter(Boolean)
        .join("\n");
}

/**
 * Assemble the full three-layer prompt for one shot. The result is stored on the slot and is the only
 * text sent to the image model, so nothing is re-composed at request time.
 */
export function assembleSlotPrompt({
    profile,
    styleText,
    globalPrompt,
    avoidPrompt,
    globalConstraints,
    slot,
    label,
}: {
    profile: ProductProfile;
    styleText: string;
    globalPrompt: string;
    avoidPrompt: string;
    globalConstraints: string[];
    slot: PromptPlanSlot;
    label: string;
}) {
    const styleBlock = [styleText.trim(), globalPrompt.trim(), globalConstraints.filter(Boolean).join("\n"), avoidPrompt.trim() ? setText("prompts.avoidLine", { text: avoidPrompt.trim() }) : ""].filter(Boolean).join("\n");
    return [
        productConstraintText(profile),
        styleBlock ? [setText("prompts.styleHeading"), styleBlock].join("\n") : "",
        [
            setText("prompts.shotHeading", { role: label }),
            slot.prompt.trim(),
            slot.requiredElements.length ? setText("prompts.requiredLine", { text: slot.requiredElements.join(", ") }) : "",
            slot.avoidElements.length ? setText("prompts.avoidLine", { text: slot.avoidElements.join(", ") }) : "",
        ]
            .filter(Boolean)
            .join("\n"),
    ]
        .filter(Boolean)
        .join("\n\n");
}

/**
 * Append the review findings for one shot to its existing prompt, so a regeneration targets exactly what
 * the review flagged. Appended once per fix round; a later round replaces the previous block.
 */
export function applyReviewFeedback(prompt: string, issues: string[]) {
    const list = issues.map((issue) => issue.trim()).filter(Boolean);
    if (!list.length) return prompt;
    const base = stripReviewFeedback(prompt);
    const feedback = [REVIEW_FEEDBACK_START, setText("prompts.fixHeading"), ...list.map((issue) => setText("prompts.fixLine", { text: issue })), REVIEW_FEEDBACK_END].join("\n");
    return [base, feedback].filter(Boolean).join("\n\n");
}

/** Drop a previously appended fix block using a language-independent marker. */
export function stripReviewFeedback(prompt: string) {
    const index = prompt.lastIndexOf(REVIEW_FEEDBACK_START);
    return index < 0 ? prompt.trimEnd() : prompt.slice(0, index).trimEnd();
}
