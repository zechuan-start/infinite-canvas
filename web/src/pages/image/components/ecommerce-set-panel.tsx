import { useRef, useState } from "react";
import { App, Button, Collapse, Input, Select, Tag, Tooltip } from "antd";
import { ArrowLeft, ArrowRight, ClipboardPaste, ListChecks, LoaderCircle, ScanSearch, Sparkles, SquareStack, Trash2, Upload, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { GenerationSettings } from "@/pages/image/components/generation-settings";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { CUSTOM_STYLE_PRESET_ID, REFERENCE_ROLES, STYLE_PRESETS, referenceRoleLabel, shotRoleLabel } from "@/lib/ecommerce-set/presets";
import { imageSizeLabel, imageQualityLabel } from "@/components/image-settings-panel";
import { modelOptionLabel, useEffectiveConfig } from "@/stores/use-config-store";
import { useEcommerceSetStore } from "@/stores/use-ecommerce-set-store";
import type { EcommerceSetRecord } from "@/types/image";
import type { ProductProfile } from "@/types/ecommerce-set";

const PROFILE_TEXT_FIELDS = ["productName", "category", "shape"] as const;
const PROFILE_LIST_FIELDS = ["materials", "colors", "surfaceDetails", "packagingDetails", "visibleText", "mustKeep", "mustAvoid", "usageNotes"] as const;

export function EcommerceSetPanel({ record }: { record: EcommerceSetRecord }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragDepthRef = useRef(0);
    const [dragActive, setDragActive] = useState(false);
    const effectiveConfig = useEffectiveConfig();
    const running = useEcommerceSetStore((state) => state.running);
    const patchDraft = useEcommerceSetStore((state) => state.patchDraft);
    const addReferences = useEcommerceSetStore((state) => state.addReferences);
    const removeReference = useEcommerceSetStore((state) => state.removeReference);
    const moveReference = useEcommerceSetStore((state) => state.moveReference);
    const setReferenceRole = useEcommerceSetStore((state) => state.setReferenceRole);
    const analyze = useEcommerceSetStore((state) => state.analyze);
    const plan = useEcommerceSetStore((state) => state.plan);
    const generate = useEcommerceSetStore((state) => state.generate);
    const stop = useEcommerceSetStore((state) => state.stop);

    const model = effectiveConfig.imageModel || effectiveConfig.model;
    const enabledSlots = record.slots.filter((slot) => slot.enabled);
    const readySlots = enabledSlots.filter((slot) => slot.prompt.trim());
    const pendingSlots = readySlots.filter((slot) => !slot.storageKey);

    const addFiles = async (files?: FileList | null) => {
        const images = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        if (!images.length) return;
        await addReferences(images.map((file) => ({ blob: file, name: file.name })));
    };

    const addFromClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                message.error(t("imageWorkbench.clipboardEmpty"));
                return;
            }
            await addReferences(blobs.map((blob, index) => ({ blob, name: `clipboard-${index + 1}.png` })));
            message.success(t("imageWorkbench.clipboardAdded", { count: blobs.length }));
        } catch {
            message.error(t("imageWorkbench.clipboardEmpty"));
        }
    };

    return (
        <div className="thin-scrollbar flex flex-col rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto">
            <Input value={record.title} onChange={(event) => patchDraft({ title: event.target.value })} placeholder={t("ecommerceSet.titlePlaceholder")} className="!text-lg !font-semibold" variant="borderless" />

            <div className="mt-4 space-y-5">
                <section className="min-w-0">
                    <div className="mb-2 flex items-center justify-between gap-3">
                        <span className="text-base font-semibold">{t("ecommerceSet.references")}</span>
                        <div className="flex gap-2">
                            <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={() => void addFromClipboard()}>
                                {t("workbench.clipboard")}
                            </Button>
                            <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                {t("workbench.upload")}
                            </Button>
                        </div>
                    </div>
                    <div
                        className={`hover-scrollbar relative flex min-h-32 w-full min-w-0 max-w-full gap-2 overflow-x-auto overflow-y-hidden rounded-lg border border-dashed p-2 transition-colors ${dragActive ? "border-stone-900 bg-stone-100/80 dark:border-stone-100 dark:bg-stone-900/80" : "border-stone-300 dark:border-stone-700"}`}
                        onDragEnter={(event) => {
                            event.preventDefault();
                            dragDepthRef.current += 1;
                            if (event.dataTransfer.types.includes("Files")) setDragActive(true);
                        }}
                        onDragOver={(event) => {
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "copy";
                        }}
                        onDragLeave={(event) => {
                            event.preventDefault();
                            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
                            if (!dragDepthRef.current) setDragActive(false);
                        }}
                        onDrop={(event) => {
                            event.preventDefault();
                            dragDepthRef.current = 0;
                            setDragActive(false);
                            void addFiles(event.dataTransfer.files);
                        }}
                    >
                        {record.references.map((item, index) => (
                            <div key={item.id} className="group w-24 shrink-0">
                                <div className="relative size-24 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                    <img src={item.dataUrl} alt={item.name} className="size-full object-cover" />
                                    <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{imageReferenceLabel(index)}</span>
                                    <button
                                        type="button"
                                        className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex"
                                        onClick={() => removeReference(item.id)}
                                        aria-label={t("imageWorkbench.removeReference")}
                                    >
                                        <Trash2 className="size-3.5" />
                                    </button>
                                    {record.references.length > 1 ? (
                                        <div className="absolute inset-x-1 bottom-1 hidden justify-between group-hover:flex">
                                            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0" icon={<ArrowLeft className="size-3" />} disabled={index <= 0} onClick={() => moveReference(index, -1)} />
                                            <Button
                                                size="small"
                                                className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0"
                                                icon={<ArrowRight className="size-3" />}
                                                disabled={index >= record.references.length - 1}
                                                onClick={() => moveReference(index, 1)}
                                            />
                                        </div>
                                    ) : null}
                                </div>
                                <Select size="small" className="mt-1 w-full" value={item.role} onChange={(value) => setReferenceRole(item.id, value)} options={REFERENCE_ROLES.map((role) => ({ value: role, label: referenceRoleLabel(role) }))} />
                            </div>
                        ))}
                        {!record.references.length ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">{dragActive ? t("imageWorkbench.dropReferences") : t("ecommerceSet.noReferences")}</div> : null}
                    </div>
                    <p className="mt-1.5 text-xs text-stone-500 dark:text-stone-400">{t("ecommerceSet.privacyHint")}</p>
                </section>

                <section>
                    <span className="mb-2 block text-base font-semibold">{t("ecommerceSet.style")}</span>
                    <div className="grid grid-cols-3 gap-2">
                        {STYLE_PRESETS.map((preset) => (
                            <button
                                key={preset.id}
                                type="button"
                                className={`cursor-pointer rounded-lg border px-2 py-1.5 text-xs transition ${record.stylePresetId === preset.id ? "border-stone-900 font-medium dark:border-stone-100" : "border-stone-200 hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"}`}
                                onClick={() => patchDraft({ stylePresetId: preset.id })}
                            >
                                {preset.label}
                            </button>
                        ))}
                    </div>
                    <Input.TextArea
                        className="mt-2"
                        value={record.customStyle}
                        onChange={(event) => patchDraft({ customStyle: event.target.value })}
                        rows={2}
                        placeholder={record.stylePresetId === CUSTOM_STYLE_PRESET_ID ? t("ecommerceSet.customStyleRequired") : t("ecommerceSet.customStylePlaceholder")}
                    />
                </section>

                <section className="grid gap-3">
                    <label className="block">
                        <span className="mb-1.5 block text-sm font-semibold">{t("ecommerceSet.globalPrompt")}</span>
                        <Input.TextArea value={record.globalPrompt} onChange={(event) => patchDraft({ globalPrompt: event.target.value })} rows={2} placeholder={t("ecommerceSet.globalPromptPlaceholder")} />
                    </label>
                    <label className="block">
                        <span className="mb-1.5 block text-sm font-semibold">{t("ecommerceSet.avoidPrompt")}</span>
                        <Input.TextArea value={record.avoidPrompt} onChange={(event) => patchDraft({ avoidPrompt: event.target.value })} rows={2} placeholder={t("ecommerceSet.avoidPromptPlaceholder")} />
                    </label>
                </section>

                <section>
                    <div className="mb-2 flex items-center justify-between gap-3">
                        <span className="text-base font-semibold">{t("ecommerceSet.profile")}</span>
                        <Button
                            size="small"
                            icon={running && record.status === "analyzing" ? <LoaderCircle className="size-3.5 animate-spin" /> : <ScanSearch className="size-3.5" />}
                            disabled={running || !record.references.length}
                            onClick={() => void analyze()}
                        >
                            {record.profile ? t("ecommerceSet.reanalyze") : t("ecommerceSet.analyze")}
                        </Button>
                    </div>
                    {record.profile ? (
                        <ProfileEditor profile={record.profile} />
                    ) : (
                        <div className="rounded-lg border border-dashed border-stone-300 px-3 py-4 text-center text-sm text-stone-500 dark:border-stone-700">
                            {record.references.length ? t("ecommerceSet.profileEmpty") : t("ecommerceSet.profileNeedsReferences")}
                        </div>
                    )}
                </section>

                <section>
                    <div className="mb-2 flex items-center justify-between gap-3">
                        <span className="text-base font-semibold">{t("ecommerceSet.shotsTitle")}</span>
                        <Button
                            size="small"
                            icon={running && record.status === "planning" ? <LoaderCircle className="size-3.5 animate-spin" /> : <ListChecks className="size-3.5" />}
                            disabled={running || !record.profile || !enabledSlots.length}
                            onClick={() => void plan()}
                        >
                            {readySlots.length ? t("ecommerceSet.replan") : t("ecommerceSet.planPrompts")}
                        </Button>
                    </div>
                    <div className="space-y-2">
                        {record.slots.map((slot, index) => (
                            <SlotPromptRow key={slot.id} slotId={slot.id} index={index} total={record.slots.length} />
                        ))}
                    </div>
                    {record.profile ? <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">{t("ecommerceSet.replanHint")}</p> : null}
                </section>

                <section className="hidden gap-4 sm:grid sm:grid-cols-2">
                    <GenerationSettings config={effectiveConfig} model={model} showCount={false} />
                </section>

                {readySlots.length ? (
                    <section className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs dark:border-stone-800 dark:bg-stone-900">
                        <div className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold">
                            <SquareStack className="size-3.5" />
                            {t("ecommerceSet.requestSummary")}
                        </div>
                        <div className="space-y-1 text-stone-600 dark:text-stone-300">
                            <div>{t("ecommerceSet.summaryModel", { model: modelOptionLabel(effectiveConfig, model), size: imageSizeLabel(effectiveConfig.size), quality: imageQualityLabel(effectiveConfig.quality) })}</div>
                            <div>{t("ecommerceSet.summaryShots", { count: readySlots.length })}</div>
                            <div>{t("ecommerceSet.summaryReferences", { count: record.references.length, labels: record.references.map((_, index) => imageReferenceLabel(index)).join(t("imageReferences.separator")) })}</div>
                        </div>
                    </section>
                ) : null}

                {record.error ? (
                    <section className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-600 dark:border-red-950 dark:bg-red-950/20 dark:text-red-300">
                        <XCircle className="mt-0.5 size-3.5 shrink-0" />
                        <span className="min-w-0 break-words">{record.error}</span>
                    </section>
                ) : null}
            </div>

            <div className="mt-auto flex gap-2 pt-6">
                <Button type="primary" size="large" block icon={<Sparkles className="size-4" />} loading={running && record.status === "generating"} disabled={running || !pendingSlots.length} onClick={() => void generate()}>
                    {pendingSlots.length && pendingSlots.length !== readySlots.length ? t("ecommerceSet.generateRemaining", { count: pendingSlots.length }) : t("ecommerceSet.generateSet", { count: pendingSlots.length || readySlots.length })}
                </Button>
                {running ? (
                    <Button size="large" danger onClick={stop}>
                        {t("ecommerceSet.stop")}
                    </Button>
                ) : null}
            </div>

            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void addFiles(event.target.files);
                    event.target.value = "";
                }}
            />
        </div>
    );
}

/** Editable product profile. Every field feeds the shot prompts, so edits apply on the next plan. */
function ProfileEditor({ profile }: { profile: ProductProfile }) {
    const { t } = useTranslation();
    const updateProfile = useEcommerceSetStore((state) => state.updateProfile);

    return (
        <div className="space-y-2 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
            <div className="grid gap-2 sm:grid-cols-3">
                {PROFILE_TEXT_FIELDS.map((field) => (
                    <label key={field} className="block min-w-0">
                        <span className="mb-1 block text-xs text-stone-500 dark:text-stone-400">{t(`ecommerceSet.profileFields.${field}`)}</span>
                        <Input size="small" value={profile[field]} onChange={(event) => updateProfile({ [field]: event.target.value })} />
                    </label>
                ))}
            </div>
            <Collapse
                ghost
                size="small"
                items={[
                    {
                        key: "details",
                        label: <span className="text-xs">{t("ecommerceSet.profileDetails")}</span>,
                        children: (
                            <div className="grid gap-2 sm:grid-cols-2">
                                {PROFILE_LIST_FIELDS.map((field) => (
                                    <label key={field} className="block min-w-0">
                                        <span className="mb-1 block text-xs text-stone-500 dark:text-stone-400">{t(`ecommerceSet.profileFields.${field}`)}</span>
                                        <Input.TextArea size="small" rows={2} value={profile[field].join("\n")} onChange={(event) => updateProfile({ [field]: splitLines(event.target.value) })} />
                                    </label>
                                ))}
                            </div>
                        ),
                    },
                ]}
            />
        </div>
    );
}

/** One shot: enable/disable, reorder, and edit the full prompt that is actually sent. */
function SlotPromptRow({ slotId, index, total }: { slotId: EcommerceSetRecord["slots"][number]["id"]; index: number; total: number }) {
    const { t } = useTranslation();
    const slot = useEcommerceSetStore((state) => state.record?.slots.find((item) => item.id === slotId));
    const toggleSlot = useEcommerceSetStore((state) => state.toggleSlot);
    const moveSlot = useEcommerceSetStore((state) => state.moveSlot);
    const editSlotPrompt = useEcommerceSetStore((state) => state.editSlotPrompt);
    if (!slot) return null;

    return (
        <div className={`rounded-lg border p-2 transition ${slot.enabled ? "border-stone-200 dark:border-stone-800" : "border-dashed border-stone-200 opacity-60 dark:border-stone-800"}`}>
            <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="text-xs text-stone-400">{index + 1}</span>
                    <span className="truncate text-sm font-medium">{shotRoleLabel(slot.id)}</span>
                    {slot.prompt.trim() ? null : <Tag className="m-0 text-[10px]">{t("ecommerceSet.noPrompt")}</Tag>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    <Button size="small" type="text" icon={<ArrowLeft className="size-3 rotate-90" />} disabled={index <= 0} onClick={() => moveSlot(index, -1)} aria-label={t("ecommerceSet.moveUp")} />
                    <Button size="small" type="text" icon={<ArrowRight className="size-3 rotate-90" />} disabled={index >= total - 1} onClick={() => moveSlot(index, 1)} aria-label={t("ecommerceSet.moveDown")} />
                    <Tooltip title={slot.enabled ? t("ecommerceSet.disableShot") : t("ecommerceSet.enableShot")}>
                        <Button size="small" type="text" onClick={() => toggleSlot(slot.id)}>
                            {slot.enabled ? t("ecommerceSet.enabled") : t("ecommerceSet.disabled")}
                        </Button>
                    </Tooltip>
                </div>
            </div>
            {slot.enabled && slot.prompt.trim() ? (
                <Collapse
                    ghost
                    size="small"
                    items={[
                        {
                            key: "prompt",
                            label: <span className="text-xs text-stone-500 dark:text-stone-400">{t("ecommerceSet.viewPrompt")}</span>,
                            children: <Input.TextArea value={slot.prompt} onChange={(event) => editSlotPrompt(slot.id, event.target.value)} rows={8} />,
                        },
                    ]}
                />
            ) : null}
        </div>
    );
}

function splitLines(value: string) {
    return value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}
