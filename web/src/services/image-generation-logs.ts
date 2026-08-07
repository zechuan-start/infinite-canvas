import localforage from "localforage";

import i18n from "@/i18n";
import { resolveImageUrl } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import type { EcommerceSetRecord, GenerationLogConfig, ImageGenerationRecord, SingleGenerationLog } from "@/types/image";

/**
 * Single source of truth for the image workbench generation history. Single-image logs and
 * e-commerce set tasks live in the same store, separated by `kind`, so cleanup, WebDAV sync and
 * the history list all see one set of records.
 */
const logStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });

export async function readImageRecords(): Promise<ImageGenerationRecord[]> {
    if (typeof window === "undefined") return [];
    try {
        const values: Partial<ImageGenerationRecord>[] = [];
        await logStore.iterate<Partial<ImageGenerationRecord>, void>((value, key) => {
            if (value && typeof value === "object") values.push({ ...value, id: value.id || key });
        });
        const records = await Promise.all(values.map(hydrateRecord));
        return records.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch {
        return [];
    }
}

export async function readImageRecord(id: string) {
    const value = await logStore.getItem<Partial<ImageGenerationRecord>>(id);
    return value ? hydrateRecord(value) : null;
}

export async function saveImageRecord(record: ImageGenerationRecord) {
    await logStore.setItem(record.id, serializeRecord(record));
}

/**
 * Remove records, then drop only the images no asset, canvas project or remaining log still references.
 * `inFlight` carries data that is not persisted yet, such as the open set draft, so its uploads survive.
 */
export async function deleteImageRecords(ids: string[], inFlight?: unknown) {
    await Promise.all(ids.map((id) => logStore.removeItem(id)));
    useAssetStore.getState().cleanupImages(inFlight);
}

/** Restore object URLs for a stored record; blob URLs never survive a reload. */
async function hydrateRecord(record: Partial<ImageGenerationRecord>): Promise<ImageGenerationRecord> {
    return record.kind === "ecommerce-set" ? hydrateSetRecord(record) : hydrateSingleLog(record as Partial<SingleGenerationLog>);
}

async function hydrateSingleLog(log: Partial<SingleGenerationLog>): Promise<SingleGenerationLog> {
    const references = await Promise.all((log.references || []).map(async (item) => ({ ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) })));
    const images = await Promise.all((log.images || []).map(async (item) => ({ ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) })));
    const config = normalizeLogConfig(log);
    return {
        id: log.id || "",
        kind: "single",
        createdAt: log.createdAt || Date.now(),
        updatedAt: log.updatedAt || log.createdAt || Date.now(),
        title: log.title || log.model || i18n.t("workbench.untitled"),
        prompt: log.prompt || log.title || "",
        time: log.time || new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model: log.model || config.imageModel || "",
        config,
        references,
        durationMs: log.durationMs || 0,
        successCount: log.successCount ?? log.imageCount ?? 0,
        failCount: log.failCount || 0,
        imageCount: log.imageCount || log.successCount || 0,
        size: log.size || config.size || "",
        quality: log.quality || config.quality || "",
        status: log.status || "success",
        images,
        thumbnails: images.map((image) => image.dataUrl).filter(Boolean),
    };
}

async function hydrateSetRecord(record: Partial<EcommerceSetRecord>): Promise<EcommerceSetRecord> {
    const references = await Promise.all((record.references || []).map(async (item) => ({ ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) })));
    const slots = await Promise.all((record.slots || []).map(async (slot) => ({ ...slot, url: slot.storageKey ? await resolveImageUrl(slot.storageKey) : undefined })));
    return {
        id: record.id || "",
        kind: "ecommerce-set",
        createdAt: record.createdAt || Date.now(),
        updatedAt: record.updatedAt || record.createdAt || Date.now(),
        title: record.title || i18n.t("ecommerceSet.untitled"),
        time: record.time || new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model: record.model || "",
        config: normalizeLogConfig(record),
        status: record.status || "draft",
        stylePresetId: record.stylePresetId || "",
        customStyle: record.customStyle || "",
        globalPrompt: record.globalPrompt || "",
        avoidPrompt: record.avoidPrompt || "",
        references,
        profile: record.profile,
        globalConstraints: record.globalConstraints || [],
        slots,
        review: record.review,
        durationMs: record.durationMs || 0,
        error: record.error,
    };
}

/** Drop every transient object URL before writing; only storage keys and metadata persist. */
function serializeRecord(record: ImageGenerationRecord): ImageGenerationRecord {
    if (record.kind === "ecommerce-set") {
        return {
            ...record,
            references: record.references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })),
            slots: record.slots.map(({ url: _url, ...slot }) => slot),
        };
    }
    return {
        ...record,
        references: record.references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })),
        images: record.images.map((image) => ({ ...image, dataUrl: image.storageKey ? "" : image.dataUrl })),
        thumbnails: [],
    };
}

function normalizeLogConfig(record: Partial<SingleGenerationLog> | Partial<EcommerceSetRecord>): GenerationLogConfig {
    const single = record as Partial<SingleGenerationLog>;
    return {
        model: record.config?.model || record.model || "",
        imageModel: record.config?.imageModel || record.model || "",
        quality: record.config?.quality || single.quality || "",
        size: record.config?.size || single.size || "",
        count: record.config?.count || String(single.imageCount || single.successCount || 1),
    };
}
