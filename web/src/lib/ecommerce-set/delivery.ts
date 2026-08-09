import { saveAs } from "file-saver";

import i18n from "@/i18n";
import { slotLabel, stylePresetLabel } from "@/lib/ecommerce-set/presets";
import { createCanvasNode, imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { createZip } from "@/lib/zip";
import { getImageBlob, resolveImageUrl } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { EcommerceSetSlot } from "@/types/ecommerce-set";
import type { EcommerceSetRecord } from "@/types/image";

const CANVAS_COLUMNS = 3;
const CANVAS_GAP = 80;
const CANVAS_NODE_MAX = 420;

/** Slots that hold a saved original; every delivery path uses exactly these. */
export function deliverableSlots(record: EcommerceSetRecord) {
    return record.slots.filter((slot): slot is EcommerceSetSlot & { storageKey: string } => slot.enabled && Boolean(slot.storageKey)).sort((a, b) => a.order - b.order);
}

/** File name uses the slot's position in the set, so single downloads and the ZIP always agree. */
function slotFileName(record: EcommerceSetRecord, slot: EcommerceSetSlot) {
    const index = deliverableSlots(record).findIndex((item) => item.id === slot.id);
    const position = index < 0 ? slot.order : index;
    return `${String(position + 1).padStart(2, "0")}-${slot.role}.${imageExtension(slot.mimeType)}`;
}

function imageExtension(mimeType?: string) {
    if (!mimeType) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    return "png";
}

/** Download one generated original, exactly as the image model returned it. */
export async function downloadSlotOriginal(record: EcommerceSetRecord, slot: EcommerceSetSlot) {
    if (!slot.storageKey) throw new Error(i18n.t("ecommerceSet.errors.slotImageMissing", { slot: slotLabel(slot) }));
    const blob = await getImageBlob(slot.storageKey);
    if (!blob) throw new Error(i18n.t("ecommerceSet.errors.slotImageMissing", { slot: slotLabel(slot) }));
    saveAs(blob, slotFileName(record, slot));
}

/**
 * Export the set as a ZIP of the untouched originals plus a task manifest. Review-only compressed copies
 * are never written to storage, so they cannot appear here.
 */
export async function exportSetPackage(record: EcommerceSetRecord) {
    const slots = deliverableSlots(record);
    if (!slots.length) throw new Error(i18n.t("ecommerceSet.errors.noDeliverables"));

    const files: Array<{ name: string; data: BlobPart }> = [];
    const manifestSlots: Array<Record<string, unknown>> = [];

    for (const slot of slots) {
        const blob = await getImageBlob(slot.storageKey);
        if (!blob) continue;
        const name = `images/${slotFileName(record, slot)}`;
        files.push({ name, data: blob });
        manifestSlots.push({
            id: slot.id,
            order: slot.order,
            role: slot.role,
            label: slotLabel(slot),
            file: name,
            prompt: slot.prompt,
            status: slot.status,
            width: slot.naturalWidth,
            height: slot.naturalHeight,
            bytes: blob.size,
            mimeType: blob.type || slot.mimeType,
            durationMs: slot.durationMs,
            attempts: slot.attempts,
            generationConfig: slot.generationConfig,
        });
    }
    if (!files.length) throw new Error(i18n.t("ecommerceSet.errors.noDeliverables"));

    const manifest = {
        app: "infinite-canvas",
        version: 1,
        kind: "ecommerce-set",
        id: record.id,
        title: record.title,
        exportedAt: new Date().toISOString(),
        status: record.status,
        model: record.model,
        config: record.config,
        style: { presetId: record.stylePresetId, preset: stylePresetLabel(record.stylePresetId), custom: record.customStyle },
        globalPrompt: record.globalPrompt,
        avoidPrompt: record.avoidPrompt,
        globalConstraints: record.globalConstraints,
        profile: record.profile,
        // Reference metadata only; the product originals themselves stay in local storage.
        references: record.references.map((item) => ({ name: item.name, role: item.role, storageKey: item.storageKey })),
        slots: manifestSlots,
        review: record.review,
    };

    const zip = await createZip([{ name: "manifest.json", data: JSON.stringify(manifest, null, 2) }, ...files]);
    saveAs(zip, `${safeFileName(record.title) || "ecommerce-set"}.zip`);
    return files.length;
}

/** Save every original into My Assets, keeping the set and shot traceable through metadata. */
export function saveSetToAssets(record: EcommerceSetRecord) {
    const slots = deliverableSlots(record);
    if (!slots.length) throw new Error(i18n.t("ecommerceSet.errors.noDeliverables"));
    const addAsset = useAssetStore.getState().addAsset;

    slots.forEach((slot) => {
        addAsset({
            kind: "image",
            title: `${record.title} · ${slotLabel(slot)}`,
            coverUrl: slot.url || "",
            tags: [],
            source: i18n.t("ecommerceSet.title"),
            data: { dataUrl: slot.url || "", storageKey: slot.storageKey, width: slot.naturalWidth || 0, height: slot.naturalHeight || 0, bytes: slot.bytes || 0, mimeType: slot.mimeType || "image/png" },
            metadata: { source: "ecommerce-set", setId: record.id, slotId: slot.id, role: slot.role, label: slotLabel(slot), stylePresetId: record.stylePresetId, prompt: slot.prompt, generationConfig: slot.generationConfig },
        });
    });
    return slots.length;
}

/**
 * Place one image node per shot, in shot order, pointing at the originals. Without `targetProjectId`
 * a new canvas is created; with it the nodes are appended below whatever the canvas already holds.
 */
export async function sendSetToCanvas(record: EcommerceSetRecord, targetProjectId?: string) {
    const slots = deliverableSlots(record);
    if (!slots.length) throw new Error(i18n.t("ecommerceSet.errors.noDeliverables"));

    const canvasStore = useCanvasStore.getState();
    const target = targetProjectId ? canvasStore.projects.find((project) => project.id === targetProjectId) : undefined;
    if (targetProjectId && !target) throw new Error(i18n.t("ecommerceSet.errors.canvasMissing"));
    const existing = target?.nodes || [];
    const originY = existing.length ? Math.max(...existing.map((node) => node.position.y + node.height)) + CANVAS_GAP : 0;

    const nodes: CanvasNodeData[] = [];
    for (const [index, slot] of slots.entries()) {
        const url = await resolveImageUrl(slot.storageKey, slot.url || "");
        if (!url) continue;
        const size = fitNodeSize(slot.naturalWidth || CANVAS_NODE_MAX, slot.naturalHeight || CANVAS_NODE_MAX, CANVAS_NODE_MAX, CANVAS_NODE_MAX);
        const position = { x: (index % CANVAS_COLUMNS) * (CANVAS_NODE_MAX + CANVAS_GAP), y: originY + Math.floor(index / CANVAS_COLUMNS) * (CANVAS_NODE_MAX + CANVAS_GAP) };
        const node = createCanvasNode(CanvasNodeType.Image, position, {
            ...imageMetadata({ url, storageKey: slot.storageKey, width: slot.naturalWidth || size.width, height: slot.naturalHeight || size.height, bytes: slot.bytes || 0, mimeType: slot.mimeType || "image/png" }),
            prompt: slot.prompt,
            model: slot.generationConfig?.model,
            size: slot.generationConfig?.size,
            quality: slot.generationConfig?.quality,
        });
        nodes.push({ ...node, title: slotLabel(slot), position, width: size.width, height: size.height });
    }
    if (!nodes.length) throw new Error(i18n.t("ecommerceSet.errors.noDeliverables"));

    const projectId = target?.id || canvasStore.createProject(record.title);
    canvasStore.updateProject(projectId, { nodes: [...existing, ...nodes] });
    return { projectId, count: nodes.length, appended: Boolean(target) };
}

function safeFileName(value: string) {
    return value.trim().replace(/[\\/:*?"<>|]/g, "_");
}
