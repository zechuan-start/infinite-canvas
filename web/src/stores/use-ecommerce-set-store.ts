import { create } from "zustand";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { CUSTOM_STYLE_PRESET_ID, guessReferenceRole, resolveStyleText, SHOT_TEMPLATES, slotDescriptor, slotLabel, STYLE_PRESETS } from "@/lib/ecommerce-set/presets";
import { applyReviewFeedback } from "@/lib/ecommerce-set/prompt-plan";
import { isReviewableSlot } from "@/lib/ecommerce-set/review";
import { analyzeProduct, generateSlotImage, planSlotPrompts, reviewSet } from "@/services/ecommerce-set-generation";
import { saveImageRecord } from "@/services/image-generation-logs";
import { deleteStoredImages, uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";
import type { EcommerceReferenceRole, EcommerceReview, EcommerceReviewSlot, EcommerceSetSlot, EcommerceShotRole, ProductProfile, ProductReference } from "@/types/ecommerce-set";
import type { EcommerceSetRecord, GenerationLogConfig } from "@/types/image";

/** Bounded queue: a six-shot set must not open six 2K image requests at once. */
const SLOT_CONCURRENCY = 3;
const PERSIST_DEBOUNCE_MS = 400;

type DraftPatch = Partial<Pick<EcommerceSetRecord, "title" | "stylePresetId" | "customStyle" | "globalPrompt" | "avoidPrompt">>;
type OperationKind = "analyze" | "plan" | "generate" | "retry" | "review";
type ActiveOperation = { id: string; taskId: string; kind: OperationKind; controller: AbortController; needsCleanup: boolean };

/** `unreviewed` sends only shots with no verdict yet; `manual` re-sends the ones flagged for a human look. */
export type ReviewScope = "all" | "unreviewed" | "manual";

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
    addSlot: (role: EcommerceShotRole) => void;
    duplicateSlot: (id: string) => void;
    removeSlot: (id: string) => void;
    editSlotShot: (id: string, patch: { label?: string; brief?: string }) => void;
    toggleSlot: (id: string) => void;
    moveSlot: (index: number, offset: number) => void;
    editSlotPrompt: (id: string, prompt: string) => void;
    generate: () => Promise<void>;
    regenerateAll: () => Promise<void>;
    retrySlot: (id: string) => Promise<void>;
    applyReviewFix: (id: string) => Promise<void>;
    review: (scope?: ReviewScope) => Promise<void>;
    reviewSlot: (id: string) => Promise<void>;
    stop: () => void;
};

let activeOperation: ActiveOperation | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let cleanupAfterPersist = false;

export const useEcommerceSetStore = create<EcommerceSetStore>((set, get) => {
    /** Write the current record immediately; called at every real state transition. */
    const persist = (record = get().record, cleanup = false) => {
        if (!record) return;
        const shouldCleanup = cleanup || cleanupAfterPersist;
        cleanupAfterPersist = false;
        if (persistTimer) {
            clearTimeout(persistTimer);
            persistTimer = null;
        }
        void saveImageRecord(record).then(() => {
            if (shouldCleanup) useAssetStore.getState().cleanupImages(record);
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

    const patchSlot = (id: string, patch: Partial<EcommerceSetSlot>, taskId?: string) => {
        const record = get().record;
        if (!record || (taskId && record.id !== taskId)) return;
        set({ record: { ...record, slots: record.slots.map((slot) => (slot.id === id ? { ...slot, ...patch } : slot)), updatedAt: Date.now() } });
    };

    const beginOperation = (taskId: string, kind: OperationKind) => {
        activeOperation?.controller.abort();
        const operation = { id: nanoid(), taskId, kind, controller: new AbortController(), needsCleanup: false };
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
        if (operation.needsCleanup) cleanupAfterPersist = true;
        set({ record: next, running: false });
        return next;
    };

    const leaveCurrentTask = () => {
        const record = cancelCurrentOperation();
        if (record && shouldPersistSetRecord(record)) persist(record);
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
        // The verdict is dropped when this shot actually starts, so a queued shot that never runs keeps its own.
        const started = get().record;
        patchRecord({ review: removeReviewSlot(started?.review, slot.id) }, operation.taskId);
        patchSlot(slot.id, { status: "generating", error: undefined }, operation.taskId);
        const referenceKey = referenceFingerprint(references);
        try {
            const image = await generateSlotImage(config, slot.prompt, references, { signal: operation.controller.signal });
            const current = get().record;
            const currentSlot = current?.slots.find((item) => item.id === slot.id);
            if (!isActive(operation) || !current || !currentSlot?.enabled || currentSlot.prompt !== slot.prompt || referenceFingerprint(current.references) !== referenceKey) {
                await deleteStoredImages([image.storageKey]);
                if (isActive(operation) && currentSlot?.status === "generating") patchSlot(slot.id, { status: "pending" }, operation.taskId);
                return false;
            }
            if (currentSlot.storageKey && currentSlot.storageKey !== image.storageKey) operation.needsCleanup = true;
            patchSlot(
                slot.id,
                {
                    status: "generated",
                    storageKey: image.storageKey,
                    referenceKey,
                    promptStale: false,
                    url: image.url,
                    naturalWidth: image.naturalWidth,
                    naturalHeight: image.naturalHeight,
                    bytes: image.bytes,
                    mimeType: image.mimeType,
                    durationMs: image.durationMs,
                    generationConfig: logConfig(config),
                    error: undefined,
                    stale: false,
                    attempts: slot.attempts + 1,
                },
                operation.taskId,
            );
            // The replaced original may still be referenced by an asset or a canvas node, so it is never
            // deleted here; the caller ends the run with the reference-aware sweep instead.
            persist();
            return true;
        } catch (error) {
            if (!isActive(operation)) return false;
            patchSlot(slot.id, { status: "generation_failed", error: readError(error), attempts: slot.attempts + 1 }, operation.taskId);
            persist();
            return false;
        }
    };

    /** Shared generation queue: `select` decides which enabled shots are (re)generated. */
    const runBatch = async (select: (slot: EcommerceSetSlot) => boolean) => {
        const record = get().record;
        if (!record || record.planStale || get().running) return;
        const targets = record.slots.filter(select);
        if (!targets.length) return;
        if (!ensureConfig("image")) return;
        const operation = beginOperation(record.id, "generate");
        const batchStartedAt = performance.now();
        const config = imageConfig();
        const references = [...record.references];
        // Queued shots keep their current status and verdict until they actually start, so stopping the batch
        // early leaves the shots it never reached exactly as they were.
        patchRecord({ model: config.model, config: logConfig(config), status: "generating", error: undefined }, record.id);

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
                const next = patchRecord({ status: settledStatus(finished), durationMs: performance.now() - batchStartedAt }, record.id);
                if (next)
                    persist(
                        next,
                        targets.some((slot) => Boolean(slot.storageKey)),
                    );
            }
        }
        finishOperation(operation);
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
                planStale: false,
                globalConstraints: [],
                slots: SHOT_TEMPLATES.map((template, index) => createSlot(template.id, index)),
                durationMs: 0,
            };
            set({ record, running: false, startedAt: 0 });
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
            if (Object.entries(patch).every(([key, value]) => record?.[key as keyof DraftPatch] === value)) return;
            const affectsPlan = Object.keys(patch).some((key) => key !== "title");
            if (affectsPlan) record = cancelCurrentOperation();
            if (!record) return;
            const next = affectsPlan ? invalidatePlan(record, patch) : { ...record, ...patch, updatedAt: Date.now() };
            set({ record: next });
            schedulePersist();
        },

        addReferences: async (inputs) => {
            if (!inputs.length) return;
            const taskId = get().record?.id;
            if (!taskId) return;
            const results = await Promise.allSettled(
                inputs.map(async (input) => {
                    const image = await uploadImage(input.blob);
                    return { id: nanoid(), name: input.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            const uploaded = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
            const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
            if (failed) {
                await deleteStoredImages(uploaded.map((item) => item.storageKey));
                throw failed.reason instanceof Error ? failed.reason : new Error(i18n.t("ecommerceSet.errors.unknown"));
            }
            if (get().record?.id !== taskId) {
                await deleteStoredImages(uploaded.map((item) => item.storageKey));
                return;
            }
            const record = cancelCurrentOperation();
            if (!record || record.id !== taskId) {
                await deleteStoredImages(uploaded.map((item) => item.storageKey));
                return;
            }
            const references: ProductReference[] = uploaded.map((item, index) => ({ ...item, role: guessReferenceRole(item.name, record.references.length + index === 0) }));
            const next = invalidateProduct(record, [...record.references, ...references]);
            set({ record: next });
            persist(next, true);
        },

        removeReference: (id) => {
            const record = cancelCurrentOperation();
            if (!record) return;
            const next = invalidateProduct(
                record,
                record.references.filter((item) => item.id !== id),
            );
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
            const next = invalidateProduct(
                record,
                record.references.map((item) => (item.id === id ? { ...item, role } : item)),
            );
            set({ record: next });
            persist(next, true);
        },

        analyze: async () => {
            const record = get().record;
            if (!record || get().running) return;
            if (!ensureConfig("vision")) return;
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
            schedulePersist();
        },

        plan: async () => {
            const record = get().record;
            if (!record?.profile || get().running) return;
            const shots = enabledShots(record);
            if (!shots.length) return;
            const styleText = resolveStyleText(record.stylePresetId, record.customStyle);
            if (record.stylePresetId === CUSTOM_STYLE_PRESET_ID && !styleText.trim()) {
                const next = patchRecord({ status: "failed", error: i18n.t("ecommerceSet.customStyleRequired") }, record.id);
                if (next) persist(next);
                return;
            }
            if (!ensureConfig("vision")) return;
            const operation = beginOperation(record.id, "plan");
            patchRecord({ status: "planning", error: undefined }, record.id);
            try {
                const result = await planSlotPrompts(visionConfig(), { profile: record.profile, styleText, globalPrompt: record.globalPrompt, avoidPrompt: record.avoidPrompt, shots }, { signal: operation.controller.signal });
                if (!isActive(operation)) return;
                const current = get().record;
                if (!current || current.id !== record.id) return;
                // A saved original only survives replanning when both its prompt and the references it was
                // generated from are unchanged; an identical prompt over new references is still out of date.
                const currentReferenceKey = referenceFingerprint(current.references);
                const slots = current.slots.map((slot) => {
                    if (!slot.enabled) return { ...slot, promptStale: true };
                    const planned = result.prompts.find((item) => item.id === slot.id);
                    if (!planned) return invalidateSlot(slot, "");
                    const unchanged = slot.prompt === planned.prompt && (!slot.storageKey || slot.referenceKey === currentReferenceKey);
                    return unchanged
                        ? { ...slot, requiredElements: planned.requiredElements, avoidElements: planned.avoidElements, promptStale: false, stale: false, status: slot.storageKey ? ("generated" as const) : ("pending" as const), error: undefined }
                        : { ...invalidateSlot(slot, planned.prompt, planned.requiredElements, planned.avoidElements), promptStale: false };
                });
                patchRecord({ status: generationStatus(slots), planStale: false, globalConstraints: result.globalConstraints, review: undefined, slots, error: undefined }, record.id);
            } catch (error) {
                if (isActive(operation)) patchRecord({ status: "failed", error: readError(error) }, record.id);
            } finally {
                if (isActive(operation)) persist(get().record, true);
                finishOperation(operation);
            }
        },

        addSlot: (role) => {
            const record = cancelCurrentOperation();
            if (!record) return;
            const slots = [...record.slots, createSlot(role, record.slots.length, nanoid(8))];
            const next = { ...record, status: "draft" as const, planStale: true, slots, updatedAt: Date.now() };
            set({ record: next });
            persist(next);
        },

        /** Copy an existing shot including its prompt, so a second angle of the same scene needs no replanning. */
        duplicateSlot: (id) => {
            const record = cancelCurrentOperation();
            const source = record?.slots.find((item) => item.id === id);
            if (!record || !source) return;
            const copy: EcommerceSetSlot = {
                ...source,
                id: nanoid(8),
                order: record.slots.length,
                label: `${slotLabel(source)} ${i18n.t("ecommerceSet.copySuffix")}`,
                status: "pending",
                storageKey: undefined,
                url: undefined,
                naturalWidth: undefined,
                naturalHeight: undefined,
                bytes: undefined,
                mimeType: undefined,
                durationMs: undefined,
                generationConfig: undefined,
                stale: false,
                attempts: 0,
                error: undefined,
            };
            const slots = [...record.slots, copy];
            const next = { ...record, status: generationStatus(slots), slots, updatedAt: Date.now() };
            set({ record: next });
            persist(next);
        },

        removeSlot: (id) => {
            const record = cancelCurrentOperation();
            if (!record || record.slots.length <= 1) return;
            const slots = record.slots.filter((slot) => slot.id !== id).map((slot, order) => ({ ...slot, order }));
            const review = removeReviewSlot(record.review, id);
            const next = { ...record, status: record.planStale ? ("draft" as const) : review ? reviewRecordStatus({ ...record, slots }, review) : generationStatus(slots), review, slots, updatedAt: Date.now() };
            set({ record: next });
            persist(next, true);
        },

        /** Renaming a shot or rewriting its brief only changes what planning is told, so the plan goes stale. */
        editSlotShot: (id, patch) => {
            const record = cancelCurrentOperation();
            const slot = record?.slots.find((item) => item.id === id);
            if (!record || !slot) return;
            if (patch.label !== undefined && patch.label === (slot.label || "")) return;
            if (patch.brief !== undefined && patch.brief === (slot.brief || "")) return;
            const slots = record.slots.map((item) => (item.id === id ? { ...item, ...patch } : item));
            const next = { ...record, status: "draft" as const, planStale: true, slots, updatedAt: Date.now() };
            set({ record: next });
            schedulePersist();
        },

        toggleSlot: (id) => {
            const record = cancelCurrentOperation();
            if (!record) return;
            const target = record.slots.find((slot) => slot.id === id);
            const slots = record.slots.map((slot) => (slot.id === id ? { ...slot, enabled: !slot.enabled } : slot));
            const review = removeReviewSlot(record.review, id);
            const planStale = Boolean(record.planStale || (target && !target.enabled && target.promptStale));
            const next = { ...record, status: planStale ? ("draft" as const) : review ? reviewRecordStatus({ ...record, slots }, review) : generationStatus(slots), planStale, review, slots, updatedAt: Date.now() };
            set({ record: next });
            persist(next);
        },

        moveSlot: (index, offset) => {
            const record = cancelCurrentOperation();
            if (!record) return;
            const next = { ...record, slots: moveItem(record.slots, index, offset).map((slot, order) => ({ ...slot, order })), updatedAt: Date.now() };
            set({ record: next });
            persist(next);
        },

        editSlotPrompt: (id, prompt) => {
            const record = cancelCurrentOperation();
            const slot = record?.slots.find((item) => item.id === id);
            if (!record || !slot || slot.prompt === prompt) return;
            const invalidated = { ...invalidateSlot(slot, prompt, slot.requiredElements, slot.avoidElements), promptStale: false };
            const slots = record.slots.map((item) => (item.id === id ? invalidated : item));
            const review = removeReviewSlot(record.review, id);
            const next = { ...record, status: record.planStale ? ("draft" as const) : review ? reviewRecordStatus({ ...record, slots }, review) : generationStatus(slots), review, slots, updatedAt: Date.now() };
            set({ record: next });
            schedulePersist();
        },

        // Resume semantics: queue missing originals plus saved originals made stale by prompt edits.
        generate: () => runBatch((slot) => slot.enabled && Boolean(slot.prompt.trim()) && (!slot.storageKey || Boolean(slot.stale))),

        /** Redo every enabled shot from its current prompt, including ones that already have an original. */
        regenerateAll: () => runBatch((slot) => slot.enabled && Boolean(slot.prompt.trim())),

        retrySlot: async (id) => {
            const record = get().record;
            // A stale plan blocks a single retry too, otherwise one shot could still run on the superseded prompt.
            if (!record || record.planStale || get().running) return;
            const slot = record.slots.find((item) => item.id === id);
            if (!slot?.enabled || !slot.prompt.trim()) return;
            if (!ensureConfig("image")) return;
            const operation = beginOperation(record.id, "retry");
            const config = imageConfig();
            patchRecord({ model: config.model, config: logConfig(config), status: "generating" }, record.id);
            const ok = await runSlot(slot, operation, config, [...record.references]);
            if (isActive(operation)) {
                const finished = get().record;
                const next = finished ? patchRecord({ status: settledStatus(finished) }, record.id) : null;
                if (next) persist(next, ok && Boolean(slot.storageKey));
            }
            finishOperation(operation);
        },

        /**
         * Fold the review findings for one shot into its prompt, then regenerate it. The findings only ever
         * reach the image model through the prompt; the review itself never triggers a request.
         */
        applyReviewFix: async (id) => {
            const record = get().record;
            if (!record || record.planStale || get().running) return;
            const slot = record.slots.find((item) => item.id === id);
            const issues = record.review?.slots.find((item) => item.slotId === id)?.issues || [];
            if (!slot?.enabled || !slot.prompt.trim() || !issues.length) return;
            if (!ensureConfig("image")) return;
            const prompt = applyReviewFeedback(slot.prompt, issues);
            if (prompt === slot.prompt) return;
            const slots = record.slots.map((item) => (item.id === id ? { ...item, prompt, promptStale: false, status: "pending" as const, stale: Boolean(item.storageKey), error: undefined } : item));
            const review = removeReviewSlot(record.review, id);
            const staged = patchRecord({ review, slots }, record.id);
            if (!staged) return;
            await get().retrySlot(id);
        },

        review: async (scope = "all") => {
            const record = get().record;
            if (!record || get().running) return;
            const reviewable = record.slots.filter(isReviewableSlot).filter((slot) => inReviewScope(record.review, slot.id, scope));
            if (!reviewable.length) return;
            if (!ensureConfig("vision")) return;
            const targets = new Set(reviewable.map((slot) => slot.id));
            const previousStatuses = new Map(record.slots.map((slot) => [slot.id, slot.status] as const));
            const previousRecordStatus = record.status;
            const previousReview = record.review;
            const operation = beginOperation(record.id, "review");
            patchRecord({ status: "reviewing", error: undefined, slots: record.slots.map((slot) => (targets.has(slot.id) ? { ...slot, status: "review_pending" } : slot)) }, record.id);
            try {
                const result = await reviewSet(visionConfig(), { references: record.references, slots: reviewable, profile: record.profile }, { signal: operation.controller.signal });
                if (!isActive(operation)) return;
                const current = get().record;
                if (!current || current.id !== record.id) return;
                const slots = current.slots.map((slot) => {
                    const reviewed = result.slots.find((item) => item.slotId === slot.id);
                    return reviewed ? { ...slot, status: reviewed.status } : slot.status === "review_pending" ? { ...slot, status: previousStatuses.get(slot.id) || ("generated" as const) } : slot;
                });
                // A partial scope keeps the earlier verdicts; a full pass replaces them.
                const review = scope === "all" ? result : mergeReview(current, result);
                const nextRecord = { ...current, slots };
                patchRecord({ status: reviewRecordStatus(nextRecord, review), review, slots }, record.id);
            } catch (error) {
                if (isActive(operation)) {
                    const slots = (get().record?.slots || []).map((slot) => (slot.status === "review_pending" ? { ...slot, status: previousStatuses.get(slot.id) || ("generated" as const) } : slot));
                    patchRecord({ status: previousRecordStatus, review: previousReview, error: readError(error), slots }, record.id);
                }
            } finally {
                if (isActive(operation)) persist();
                finishOperation(operation);
            }
        },

        reviewSlot: async (id) => {
            const record = get().record;
            if (!record || get().running) return;
            const slot = record.slots.find((item) => item.id === id);
            if (!slot || !isReviewableSlot(slot)) return;
            if (!ensureConfig("vision")) return;
            const previousStatus = slot.status === "review_pending" ? record.review?.slots.find((item) => item.slotId === id)?.status || "generated" : slot.status;
            const previousRecordStatus = record.status;
            const previousReview = record.review;
            const operation = beginOperation(record.id, "review");
            patchRecord({ status: "reviewing", error: undefined, slots: record.slots.map((item) => (item.id === id ? { ...item, status: "review_pending" } : item)) }, record.id);
            try {
                const result = await reviewSet(visionConfig(), { references: record.references, slots: [slot], profile: record.profile }, { signal: operation.controller.signal });
                if (!isActive(operation)) return;
                const current = get().record;
                const resultSlot = result.slots.find((item) => item.slotId === id);
                if (!current || current.id !== record.id) return;
                if (!resultSlot) throw new Error(i18n.t("ecommerceSet.errors.reviewSlotMissing", { slot: slotLabel(slot) }));
                const slots = current.slots.map((item) => (item.id === id ? { ...item, status: resultSlot.status } : item));
                const mergedReview = mergeReview(current, result);
                const nextRecord = { ...current, slots };
                patchRecord({ status: reviewRecordStatus(nextRecord, mergedReview), review: mergedReview, slots }, record.id);
            } catch (error) {
                if (isActive(operation)) {
                    const current = get().record;
                    const slots = current?.slots.map((item) => (item.id === id ? { ...item, status: previousStatus } : item));
                    patchRecord({ status: previousRecordStatus, review: previousReview, error: readError(error), ...(slots ? { slots } : {}) }, record.id);
                }
            } finally {
                if (isActive(operation)) persist();
                finishOperation(operation);
            }
        },

        stop: () => {
            const operation = activeOperation;
            const startedAt = get().startedAt;
            let record = cancelCurrentOperation();
            if (record && startedAt && (operation?.kind === "generate" || operation?.kind === "retry")) {
                record = { ...record, durationMs: performance.now() - startedAt, updatedAt: Date.now() };
                set({ record });
            }
            if (record) persist(record);
        },
    };
});

function enabledShots(record: EcommerceSetRecord) {
    return record.slots.filter((slot) => slot.enabled).map(slotDescriptor);
}

function createSlot(role: EcommerceShotRole, order: number, id: string = role): EcommerceSetSlot {
    return { id, role, order, enabled: true, prompt: "", requiredElements: [], avoidElements: [], status: "pending", attempts: 0 };
}

/** A shot needs review when it has no verdict yet, or its last verdict asked for a manual check. */
export function inReviewScope(review: EcommerceReview | undefined, id: string, scope: ReviewScope) {
    if (scope === "all") return true;
    const verdict = review?.slots.find((slot) => slot.slotId === id);
    return scope === "unreviewed" ? !verdict : verdict?.status === "manual_review";
}

function dropReviewSlots(review: EcommerceReview | undefined, ids: Set<string>) {
    if (!review) return undefined;
    const slots = review.slots.filter((slot) => !ids.has(slot.slotId));
    if (!slots.length) return undefined;
    return { ...review, status: reviewStatus(slots), summary: "", error: undefined, slots };
}

/** Derive the set status from the slots themselves, so saved originals are the single source of truth. */
function generationStatus(slots: EcommerceSetSlot[]): EcommerceSetRecord["status"] {
    const enabled = slots.filter((slot) => slot.enabled);
    if (!enabled.length) return "draft";
    const succeeded = enabled.filter((slot) => slot.storageKey && !slot.stale).length;
    const failed = enabled.filter((slot) => slot.status === "generation_failed").length;
    if (failed) return succeeded ? "partial" : "failed";
    if (succeeded === enabled.length) return "generated";
    if (succeeded) return "partial";
    return enabled.every((slot) => slot.prompt.trim()) ? "prompt_ready" : "draft";
}

/**
 * Status after a generation run settles. Verdicts kept by the shots the run never reached still count, so
 * a set that was fully reviewed before a partial regeneration does not lose its `reviewed` status.
 */
function settledStatus(record: EcommerceSetRecord) {
    return record.review ? reviewRecordStatus(record, record.review) : generationStatus(record.slots);
}

function reviewStatus(slots: EcommerceReviewSlot[]): EcommerceReview["status"] {
    return slots.some((slot) => slot.status === "manual_review") ? "manual_review" : "passed";
}

function removeReviewSlot(review: EcommerceReview | undefined, id: string) {
    return dropReviewSlots(review, new Set([id]));
}

function mergeReview(record: EcommerceSetRecord, incoming: EcommerceReview): EcommerceReview {
    const bySlot = new Map(record.review?.slots.map((slot) => [slot.slotId, slot] as const));
    incoming.slots.forEach((slot) => bySlot.set(slot.slotId, slot));
    const slots = record.slots.flatMap((slot) => {
        if (!isReviewableSlot(slot)) return [];
        const reviewSlot = bySlot.get(slot.id);
        return reviewSlot ? [reviewSlot] : [];
    });
    const previous = record.review;
    return {
        ...incoming,
        status: incoming.status === "failed" ? "failed" : reviewStatus(slots),
        summary: incoming.status === "failed" ? incoming.summary : slots.length === incoming.slots.length ? incoming.summary : "",
        requestBytes: (previous?.requestBytes || 0) + incoming.requestBytes,
        batches: (previous?.batches || 0) + incoming.batches,
        slots,
    };
}

function reviewRecordStatus(record: EcommerceSetRecord, review: EcommerceReview) {
    if (review.status === "failed") return generationStatus(record.slots);
    const enabled = record.slots.filter((slot) => slot.enabled);
    const generationComplete = enabled.length > 0 && enabled.every((slot) => Boolean(slot.storageKey) && !slot.stale && slot.status !== "generation_failed");
    const complete = generationComplete && enabled.every((slot) => review.slots.some((item) => item.slotId === slot.id));
    return complete ? ("reviewed" as const) : generationStatus(record.slots);
}

/** Vision and planning calls use the configured text model, which must accept image input. */
function visionConfig(): AiConfig {
    const config = useConfigStore.getState().config;
    return { ...config, channelMode: "local", model: config.textModel || config.model };
}

function ensureConfig(kind: "image" | "vision") {
    const store = useConfigStore.getState();
    const model = kind === "image" ? store.config.imageModel || store.config.model : store.config.textModel || store.config.model;
    if (store.isAiConfigReady(store.config, model)) return true;
    store.openConfigDialog(true);
    return false;
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

function invalidateSlot(slot: EcommerceSetSlot, prompt = slot.prompt, requiredElements = slot.requiredElements, avoidElements = slot.avoidElements): EcommerceSetSlot {
    return { ...slot, prompt, requiredElements, avoidElements, status: "pending", stale: Boolean(slot.storageKey), error: undefined };
}

function invalidatePlan(record: EcommerceSetRecord, patch: Partial<EcommerceSetRecord>): EcommerceSetRecord {
    return { ...record, ...patch, status: "draft", planStale: true, globalConstraints: [], slots: record.slots.map((slot) => invalidateSlot(slot)), review: undefined, durationMs: 0, error: undefined, updatedAt: Date.now() };
}

function invalidateProduct(record: EcommerceSetRecord, references: ProductReference[]) {
    return { ...invalidatePlan(record, { references }), profile: undefined };
}

function normalizeStoppedRecord(record: EcommerceSetRecord): EcommerceSetRecord {
    const slots = record.slots.map((slot) => {
        if (slot.status === "generating") return { ...slot, status: slot.storageKey && !slot.stale ? ("generated" as const) : ("pending" as const) };
        if (slot.status !== "review_pending") return slot;
        const previous = record.review?.slots.find((item) => item.slotId === slot.id);
        return { ...slot, status: previous?.status || ("generated" as const) };
    });
    const wasReviewing = record.status === "reviewing";
    const status =
        record.status === "generating"
            ? slots.some((slot) => slot.enabled && slot.storageKey)
                ? generationStatus(slots)
                : "cancelled"
            : wasReviewing
              ? generationStatus(slots)
              : record.status === "analyzing" || record.status === "planning"
                ? "cancelled"
                : record.status;
    return { ...record, status, slots, ...(wasReviewing ? { review: record.review } : {}), updatedAt: Date.now() };
}

function referenceFingerprint(references: ProductReference[]) {
    return references.map((reference) => `${reference.id}:${reference.storageKey || reference.dataUrl}:${reference.role}`).join("|");
}

export function shouldPersistSetRecord(record: EcommerceSetRecord) {
    const untouched =
        record.title === i18n.t("ecommerceSet.untitled") &&
        record.stylePresetId === STYLE_PRESETS[0].id &&
        !record.customStyle &&
        !record.globalPrompt &&
        !record.avoidPrompt &&
        !record.references.length &&
        !record.profile &&
        !record.review &&
        !record.error &&
        !record.slots.some((slot) => !slot.enabled || slot.prompt || slot.storageKey || slot.status !== "pending" || slot.attempts);
    return !untouched;
}
