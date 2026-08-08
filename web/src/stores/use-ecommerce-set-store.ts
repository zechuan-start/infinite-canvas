import { create } from "zustand";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { resolveStyleText, SHOT_TEMPLATES, STYLE_PRESETS } from "@/lib/ecommerce-set/presets";
import { analyzeProduct, generateSlotImage, planSlotPrompts, reviewSet } from "@/services/ecommerce-set-generation";
import { saveImageRecord } from "@/services/image-generation-logs";
import { deleteStoredImages, uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";
import type { EcommerceReferenceRole, EcommerceSetSlot, EcommerceShotRole, ProductProfile, ProductReference } from "@/types/ecommerce-set";
import type { EcommerceSetRecord, GenerationLogConfig } from "@/types/image";

/** Bounded queue: a six-shot set must not open six 2K image requests at once. */
const SLOT_CONCURRENCY = 3;
const PERSIST_DEBOUNCE_MS = 400;

type DraftPatch = Partial<Pick<EcommerceSetRecord, "title" | "stylePresetId" | "customStyle" | "globalPrompt" | "avoidPrompt">>;
type OperationKind = "analyze" | "plan" | "generate" | "retry" | "review";
type ActiveOperation = { id: string; taskId: string; kind: OperationKind; controller: AbortController };

type EcommerceSetStore = {
    record: EcommerceSetRecord | null;
    running: boolean;
    startedAt: number;
    createTask: () => void;
    openTask: (record: EcommerceSetRecord) => void;
    closeTask: () => void;
    discardTask: () => void;
    patchDraft: (patch: DraftPatch) => void;
    addReferences: (inputs: Array<{ blob: Blob; name: string }>) => Promise<void>;
    removeReference: (id: string) => void;
    moveReference: (index: number, offset: number) => void;
    setReferenceRole: (id: string, role: EcommerceReferenceRole) => void;
    analyze: () => Promise<void>;
    updateProfile: (patch: Partial<ProductProfile>) => void;
    plan: () => Promise<void>;
    toggleSlot: (id: EcommerceShotRole) => void;
    moveSlot: (index: number, offset: number) => void;
    editSlotPrompt: (id: EcommerceShotRole, prompt: string) => void;
    generate: () => Promise<void>;
    retrySlot: (id: EcommerceShotRole) => Promise<void>;
    review: () => Promise<void>;
    stop: () => void;
};

let activeOperation: ActiveOperation | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

export const useEcommerceSetStore = create<EcommerceSetStore>((set, get) => {
    /** Write the current record immediately; called at every real state transition. */
    const persist = (record = get().record, cleanup = false) => {
        if (!record) return;
        if (persistTimer) {
            clearTimeout(persistTimer);
            persistTimer = null;
        }
        void saveImageRecord(record).then(() => {
            if (cleanup) useAssetStore.getState().cleanupImages(record);
        });
    };

    /** Debounced write for text edits, so typing does not hammer IndexedDB. */
    const schedulePersist = () => {
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = setTimeout(() => {
            persistTimer = null;
            persist();
        }, PERSIST_DEBOUNCE_MS);
    };

    const patchRecord = (patch: Partial<EcommerceSetRecord>, taskId?: string) => {
        const record = get().record;
        if (!record || (taskId && record.id !== taskId)) return null;
        const next = { ...record, ...patch, updatedAt: Date.now() };
        set({ record: next });
        return next;
    };

    const patchSlot = (id: EcommerceShotRole, patch: Partial<EcommerceSetSlot>, taskId?: string) => {
        const record = get().record;
        if (!record || (taskId && record.id !== taskId)) return;
        set({ record: { ...record, slots: record.slots.map((slot) => (slot.id === id ? { ...slot, ...patch } : slot)), updatedAt: Date.now() } });
    };

    const beginOperation = (taskId: string, kind: OperationKind) => {
        activeOperation?.controller.abort();
        const operation = { id: nanoid(), taskId, kind, controller: new AbortController() };
        activeOperation = operation;
        set({ running: true, startedAt: performance.now() });
        return operation;
    };

    const isActive = (operation: ActiveOperation) => activeOperation === operation && get().record?.id === operation.taskId;

    const finishOperation = (operation: ActiveOperation) => {
        if (activeOperation !== operation) return;
        activeOperation = null;
        set({ running: false });
    };

    const cancelCurrentOperation = () => {
        const operation = activeOperation;
        const record = get().record;
        if (!operation) return record;
        operation.controller.abort();
        activeOperation = null;
        if (!record || record.id !== operation.taskId) {
            set({ running: false });
            return record;
        }
        const next = normalizeStoppedRecord(record);
        set({ record: next, running: false });
        return next;
    };

    const leaveCurrentTask = () => {
        const record = cancelCurrentOperation();
        if (record) persist(record);
        set({ running: false, startedAt: 0 });
    };

    const discardCurrentTask = () => {
        if (persistTimer) {
            clearTimeout(persistTimer);
            persistTimer = null;
        }
        activeOperation?.controller.abort();
        activeOperation = null;
        set({ record: null, running: false, startedAt: 0 });
    };

    /** Run one shot: request, save the original, keep only metadata in state. */
    const runSlot = async (slot: EcommerceSetSlot, operation: ActiveOperation, config: AiConfig, references: ProductReference[]) => {
        if (!isActive(operation)) return false;
        patchSlot(slot.id, { status: "generating", error: undefined }, operation.taskId);
        try {
            const image = await generateSlotImage(config, slot.prompt, references, { signal: operation.controller.signal });
            const current = get().record;
            const currentSlot = current?.slots.find((item) => item.id === slot.id);
            if (!isActive(operation) || !current || !currentSlot?.enabled || currentSlot.prompt !== slot.prompt || referenceFingerprint(current.references) !== referenceFingerprint(references)) {
                await deleteStoredImages([image.storageKey]);
                if (isActive(operation) && currentSlot?.status === "generating") patchSlot(slot.id, { status: "pending" }, operation.taskId);
                return false;
            }
            patchSlot(slot.id, {
                status: "generated",
                storageKey: image.storageKey,
                url: image.url,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
                bytes: image.bytes,
                mimeType: image.mimeType,
                durationMs: image.durationMs,
                generationConfig: logConfig(config),
                error: undefined,
                attempts: slot.attempts + 1,
            }, operation.taskId);
            persist();
            return true;
        } catch (error) {
            if (!isActive(operation)) return false;
            if (operation.controller.signal.aborted) {
                patchSlot(slot.id, { status: "pending", attempts: slot.attempts + 1 }, operation.taskId);
                return false;
            }
            patchSlot(slot.id, { status: "generation_failed", error: readError(error), attempts: slot.attempts + 1 }, operation.taskId);
            persist();
            return false;
        }
    };

    return {
        record: null,
        running: false,
        startedAt: 0,

        createTask: () => {
            leaveCurrentTask();
            const config = useConfigStore.getState().config;
            const now = Date.now();
            const record: EcommerceSetRecord = {
                id: nanoid(),
                kind: "ecommerce-set",
                createdAt: now,
                updatedAt: now,
                title: i18n.t("ecommerceSet.untitled"),
                time: new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
                model: config.imageModel || config.model,
                config: logConfig(config),
                status: "draft",
                stylePresetId: STYLE_PRESETS[0].id,
                customStyle: "",
                globalPrompt: "",
                avoidPrompt: "",
                references: [],
                globalConstraints: [],
                slots: SHOT_TEMPLATES.map((template, index) => ({ id: template.id, order: index, enabled: true, prompt: "", requiredElements: [], avoidElements: [], status: "pending", attempts: 0 })),
                durationMs: 0,
            };
            set({ record, running: false, startedAt: 0 });
            persist(record);
        },

        openTask: (record) => {
            leaveCurrentTask();
            const next = normalizeStoppedRecord(record);
            set({ record: next, running: false, startedAt: 0 });
            persist(next);
        },
        closeTask: () => {
            leaveCurrentTask();
            set({ record: null, running: false, startedAt: 0 });
        },
        discardTask: discardCurrentTask,

        patchDraft: (patch) => {
            let record = get().record;
            if (!record) return;
            const affectsPlan = Object.keys(patch).some((key) => key !== "title");
            if (affectsPlan) record = cancelCurrentOperation();
            if (!record) return;
            const next = affectsPlan ? invalidatePlan(record, patch) : { ...record, ...patch, updatedAt: Date.now() };
            set({ record: next });
            affectsPlan ? persist(next, true) : schedulePersist();
        },

        addReferences: async (inputs) => {
            if (!inputs.length) return;
            const taskId = get().record?.id;
            if (!taskId) return;
            const uploaded = await Promise.all(
                inputs.map(async (input) => {
                    const image = await uploadImage(input.blob);
                    return { id: nanoid(), name: input.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            if (get().record?.id !== taskId) {
                await deleteStoredImages(uploaded.map((item) => item.storageKey));
                return;
            }
            const record = cancelCurrentOperation();
            if (!record || record.id !== taskId) {
                await deleteStoredImages(uploaded.map((item) => item.storageKey));
                return;
            }
            const references: ProductReference[] = uploaded.map((item, index) => ({ ...item, role: record.references.length + index === 0 ? "main" : "detail" }));
            const next = invalidateProduct(record, [...record.references, ...references]);
            set({ record: next });
            persist(next, true);
        },

        removeReference: (id) => {
            const record = cancelCurrentOperation();
            if (!record) return;
            const next = invalidateProduct(record, record.references.filter((item) => item.id !== id));
            set({ record: next });
            persist(next, true);
        },

        moveReference: (index, offset) => {
            const record = cancelCurrentOperation();
            if (!record) return;
            const next = invalidateProduct(record, moveItem(record.references, index, offset));
            set({ record: next });
            persist(next, true);
        },

        setReferenceRole: (id, role) => {
            const record = cancelCurrentOperation();
            if (!record) return;
            const next = invalidateProduct(record, record.references.map((item) => (item.id === id ? { ...item, role } : item)));
            set({ record: next });
            persist(next, true);
        },

        analyze: async () => {
            const record = get().record;
            if (!record || get().running) return;
            const operation = beginOperation(record.id, "analyze");
            patchRecord({ status: "analyzing", error: undefined }, record.id);
            try {
                const profile = await analyzeProduct(visionConfig(), record.references, { signal: operation.controller.signal });
                if (isActive(operation)) {
                    const current = get().record;
                    if (current?.id === record.id) {
                        const next = invalidatePlan(current, { profile });
                        set({ record: next });
                    }
                }
            } catch (error) {
                if (isActive(operation)) patchRecord({ status: "failed", error: readError(error) }, record.id);
            } finally {
                if (isActive(operation)) persist(get().record, true);
                finishOperation(operation);
            }
        },

        updateProfile: (patch) => {
            const record = cancelCurrentOperation();
            if (!record?.profile) return;
            const next = invalidatePlan(record, { profile: { ...record.profile, ...patch } });
            set({ record: next });
            persist(next, true);
        },

        plan: async () => {
            const record = get().record;
            if (!record?.profile || get().running) return;
            const slotIds = enabledSlotIds(record);
            if (!slotIds.length) return;
            const operation = beginOperation(record.id, "plan");
            patchRecord({ status: "planning", error: undefined }, record.id);
            try {
                const result = await planSlotPrompts(
                    visionConfig(),
                    { profile: record.profile, styleText: resolveStyleText(record.stylePresetId, record.customStyle), globalPrompt: record.globalPrompt, avoidPrompt: record.avoidPrompt, slotIds },
                    { signal: operation.controller.signal },
                );
                if (!isActive(operation)) return;
                const current = get().record;
                if (!current || current.id !== record.id) return;
                const slots = current.slots.map((slot) => {
                    const planned = result.prompts.find((item) => item.id === slot.id);
                    if (!planned) return resetSlot(slot, "");
                    return slot.prompt === planned.prompt ? { ...slot, requiredElements: planned.requiredElements, avoidElements: planned.avoidElements } : resetSlot(slot, planned.prompt, planned.requiredElements, planned.avoidElements);
                });
                patchRecord({ status: "prompt_ready", globalConstraints: result.globalConstraints, review: undefined, slots, error: undefined }, record.id);
            } catch (error) {
                if (isActive(operation)) patchRecord({ status: "failed", error: readError(error) }, record.id);
            } finally {
                if (isActive(operation)) persist(get().record, true);
                finishOperation(operation);
            }
        },

        toggleSlot: (id) => {
            const record = cancelCurrentOperation();
            if (!record) return;
            const slots = record.slots.map((slot) => (slot.id === id ? { ...slot, enabled: !slot.enabled } : slot));
            const next = { ...record, status: generationStatus(slots), review: undefined, slots, updatedAt: Date.now() };
            set({ record: next });
            persist(next);
        },

        moveSlot: (index, offset) => {
            const record = cancelCurrentOperation();
            if (!record) return;
            const next = { ...record, review: undefined, slots: moveItem(record.slots, index, offset).map((slot, order) => ({ ...slot, order })), updatedAt: Date.now() };
            set({ record: next });
            persist(next);
        },

        editSlotPrompt: (id, prompt) => {
            const record = cancelCurrentOperation();
            const slot = record?.slots.find((item) => item.id === id);
            if (!record || !slot || slot.prompt === prompt) return;
            const invalidated = resetSlot(slot, prompt, slot.requiredElements, slot.avoidElements);
            const next = { ...record, status: "prompt_ready" as const, review: undefined, slots: record.slots.map((item) => (item.id === id ? invalidated : item)), updatedAt: Date.now() };
            set({ record: next });
            slot.storageKey ? persist(next, true) : schedulePersist();
        },

        generate: async () => {
            const record = get().record;
            if (!record || get().running) return;
            // Resume semantics: only shots that have a prompt and no saved original are queued.
            const targets = record.slots.filter((slot) => slot.enabled && slot.prompt.trim() && !slot.storageKey);
            if (!targets.length) return;
            const operation = beginOperation(record.id, "generate");
            const batchStartedAt = performance.now();
            const config = imageConfig();
            const references = [...record.references];
            patchRecord({ model: config.model, config: logConfig(config), status: "generating", error: undefined, slots: record.slots.map((slot) => (targets.some((item) => item.id === slot.id) ? { ...slot, status: "pending", error: undefined } : slot)) }, record.id);

            let index = 0;
            await Promise.all(
                Array.from({ length: Math.min(SLOT_CONCURRENCY, targets.length) }, async () => {
                    while (index < targets.length) {
                        if (!isActive(operation) || operation.controller.signal.aborted) return;
                        const target = targets[index++];
                        await runSlot(target, operation, config, references);
                    }
                }),
            );

            if (isActive(operation)) {
                const finished = get().record;
                if (finished) {
                    patchRecord({ status: generationStatus(finished.slots), durationMs: performance.now() - batchStartedAt }, record.id);
                    persist();
                }
            }
            finishOperation(operation);
        },

        retrySlot: async (id) => {
            const record = get().record;
            if (!record || get().running) return;
            const slot = record.slots.find((item) => item.id === id);
            if (!slot?.enabled || !slot.prompt.trim()) return;
            const operation = beginOperation(record.id, "retry");
            const config = imageConfig();
            const slots = record.slots.map((item) => (item.status === "passed" || item.status === "manual_review" ? { ...item, status: "generated" as const } : item));
            patchRecord({ model: config.model, config: logConfig(config), status: "generating", review: undefined, slots }, record.id);
            const ok = await runSlot(slot, operation, config, [...record.references]);
            if (isActive(operation)) {
                const finished = get().record;
                const next = finished ? patchRecord({ status: generationStatus(finished.slots) }, record.id) : null;
                if (next) persist(next, ok && Boolean(slot.storageKey));
            }
            finishOperation(operation);
        },

        review: async () => {
            const record = get().record;
            if (!record || get().running) return;
            const reviewable = record.slots.filter((slot) => slot.enabled && slot.storageKey);
            if (!reviewable.length) return;
            const operation = beginOperation(record.id, "review");
            patchRecord({ status: "reviewing", error: undefined, slots: record.slots.map((slot) => (slot.enabled && slot.storageKey ? { ...slot, status: "review_pending" } : slot)) }, record.id);
            try {
                const review = await reviewSet(visionConfig(), { references: record.references, slots: reviewable, profile: record.profile }, { signal: operation.controller.signal });
                if (!isActive(operation)) return;
                const current = get().record;
                if (!current || current.id !== record.id) return;
                const slots = current.slots.map((slot) => {
                    const result = review.slots.find((item) => item.slotId === slot.id);
                    return result ? { ...slot, status: result.status } : slot;
                });
                patchRecord({ status: "reviewed", review, slots }, record.id);
            } catch (error) {
                if (isActive(operation)) {
                    const slots = (get().record?.slots || []).map((slot) => (slot.status === "review_pending" ? { ...slot, status: "generated" as const } : slot));
                    patchRecord({ status: generationStatus(slots), review: { reviewedAt: Date.now(), status: "failed", summary: "", requestBytes: 0, batches: 0, slots: [], error: readError(error) }, slots }, record.id);
                }
            } finally {
                if (isActive(operation)) persist();
                finishOperation(operation);
            }
        },

        stop: () => {
            const record = cancelCurrentOperation();
            if (record) persist(record);
        },
    };
});

function enabledSlotIds(record: EcommerceSetRecord) {
    return record.slots.filter((slot) => slot.enabled).map((slot) => slot.id);
}

/** Derive the set status from the slots themselves, so saved originals are the single source of truth. */
function generationStatus(slots: EcommerceSetSlot[]): EcommerceSetRecord["status"] {
    const enabled = slots.filter((slot) => slot.enabled);
    if (!enabled.length) return "draft";
    const succeeded = enabled.filter((slot) => slot.storageKey).length;
    const failed = enabled.filter((slot) => slot.status === "generation_failed").length;
    if (failed) return succeeded ? "partial" : "failed";
    if (succeeded === enabled.length) return "generated";
    if (succeeded) return "partial";
    return enabled.every((slot) => slot.prompt.trim()) ? "prompt_ready" : "draft";
}

/** Vision and planning calls use the configured text model, which must accept image input. */
function visionConfig(): AiConfig {
    const config = useConfigStore.getState().config;
    return { ...config, channelMode: "local", model: config.textModel || config.model };
}

/** Image calls always use `count = 1`, because every shot is its own request. */
function imageConfig(): AiConfig {
    const config = useConfigStore.getState().config;
    return { ...config, channelMode: "local", model: config.imageModel || config.model, count: "1" };
}

function logConfig(config: AiConfig): GenerationLogConfig {
    return { model: config.model, imageModel: config.imageModel, quality: config.quality, size: config.size, count: "1" };
}

function moveItem<T>(items: T[], index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= items.length) return items;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
}

function readError(error: unknown) {
    return error instanceof Error ? error.message : i18n.t("ecommerceSet.errors.unknown");
}

function resetSlot(slot: EcommerceSetSlot, prompt: string, requiredElements: string[] = [], avoidElements: string[] = []): EcommerceSetSlot {
    const { storageKey: _storageKey, url: _url, naturalWidth: _naturalWidth, naturalHeight: _naturalHeight, bytes: _bytes, mimeType: _mimeType, durationMs: _durationMs, generationConfig: _generationConfig, error: _error, ...rest } = slot;
    return { ...rest, prompt, requiredElements, avoidElements, status: "pending", attempts: 0 };
}

function invalidatePlan(record: EcommerceSetRecord, patch: Partial<EcommerceSetRecord>): EcommerceSetRecord {
    return { ...record, ...patch, status: "draft", globalConstraints: [], slots: record.slots.map((slot) => resetSlot(slot, "")), review: undefined, durationMs: 0, error: undefined, updatedAt: Date.now() };
}

function invalidateProduct(record: EcommerceSetRecord, references: ProductReference[]) {
    return { ...invalidatePlan(record, { references }), profile: undefined };
}

function normalizeStoppedRecord(record: EcommerceSetRecord): EcommerceSetRecord {
    const slots = record.slots.map((slot) => {
        if (slot.status === "generating") return { ...slot, status: slot.storageKey ? ("generated" as const) : ("pending" as const) };
        if (slot.status !== "review_pending") return slot;
        const previous = record.review?.slots.find((item) => item.slotId === slot.id);
        return { ...slot, status: previous?.status || ("generated" as const) };
    });
    const wasReviewing = record.status === "reviewing";
    const status = record.status === "generating" ? (slots.some((slot) => slot.enabled && slot.storageKey) ? generationStatus(slots) : "cancelled") : wasReviewing ? generationStatus(slots) : record.status === "analyzing" || record.status === "planning" ? "cancelled" : record.status;
    return { ...record, status, slots, ...(wasReviewing ? { review: record.review } : {}), updatedAt: Date.now() };
}

function referenceFingerprint(references: ProductReference[]) {
    return references.map((reference) => `${reference.id}:${reference.storageKey || reference.dataUrl}:${reference.role}`).join("|");
}
