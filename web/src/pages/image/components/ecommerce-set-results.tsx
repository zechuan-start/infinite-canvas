import { Check, Download, FolderPlus, LoaderCircle, PackageOpen, RefreshCw, Send, ShoppingBag, X } from "lucide-react";
import { App, Button, Empty, Image, Tag, Tooltip, Typography } from "antd";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { deliverableSlots, downloadSlotOriginal, exportSetPackage, saveSetToAssets, sendSetToCanvas } from "@/lib/ecommerce-set/delivery";
import { setStatusLabel, shotRoleLabel, slotStatusLabel } from "@/lib/ecommerce-set/presets";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { imageQualityLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { modelOptionName } from "@/stores/use-config-store";
import { useEcommerceSetStore } from "@/stores/use-ecommerce-set-store";
import type { EcommerceReviewSlot, EcommerceSetSlot } from "@/types/ecommerce-set";
import type { EcommerceSetRecord } from "@/types/image";

export function EcommerceSetResults({ record }: { record: EcommerceSetRecord }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const running = useEcommerceSetStore((state) => state.running);
    const retrySlot = useEcommerceSetStore((state) => state.retrySlot);
    const review = useEcommerceSetStore((state) => state.review);
    const slots = [...record.slots].sort((a, b) => a.order - b.order).filter((slot) => slot.enabled || slot.storageKey);
    const deliverables = deliverableSlots(record);
    const reviewFailed = record.review?.status === "failed";

    const run = async (action: () => Promise<string> | string) => {
        try {
            message.success(await action());
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("ecommerceSet.errors.unknown"));
        }
    };

    return (
        <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h2 className="text-xl font-semibold">{t("ecommerceSet.results")}</h2>
                    <Tag className="m-0">{setStatusLabel(record.status)}</Tag>
                    {deliverables.length ? <Tag className="m-0">{t("ecommerceSet.deliverableCount", { count: deliverables.length })}</Tag> : null}
                    {record.durationMs ? (
                        <Tag className="m-0" color="green">
                            {formatDuration(record.durationMs)}
                        </Tag>
                    ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button size="small" icon={<Check className="size-3.5" />} disabled={running || !deliverables.length} onClick={() => void review()}>
                        {t("ecommerceSet.review")}
                    </Button>
                    <Button size="small" icon={<PackageOpen className="size-3.5" />} disabled={!deliverables.length} onClick={() => void run(async () => t("ecommerceSet.exported", { count: await exportSetPackage(record) }))}>
                        {t("ecommerceSet.exportZip")}
                    </Button>
                    <Button size="small" icon={<FolderPlus className="size-3.5" />} disabled={!deliverables.length} onClick={() => void run(() => t("ecommerceSet.savedToAssets", { count: saveSetToAssets(record) }))}>
                        {t("common.addToAssets")}
                    </Button>
                    <Button
                        size="small"
                        icon={<Send className="size-3.5" />}
                        disabled={!deliverables.length}
                        onClick={() =>
                            void run(async () => {
                                const result = await sendSetToCanvas(record);
                                navigate(`/canvas/${result.projectId}`);
                                return t("ecommerceSet.sentToCanvas", { count: result.count });
                            })
                        }
                    >
                        {t("ecommerceSet.sendToCanvas")}
                    </Button>
                </div>
            </div>

            {record.review ? <ReviewSummary record={record} /> : null}
            {reviewFailed && record.review?.error ? (
                <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300">
                    {t("ecommerceSet.reviewFailedHint")}
                    <div className="mt-1 text-xs">{record.review.error}</div>
                </div>
            ) : null}

            {slots.length ? (
                <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                    {slots.map((slot, index) => (
                        <SlotCard
                            key={slot.id}
                            slot={slot}
                            index={index}
                            reviewSlot={record.review?.slots.find((item) => item.slotId === slot.id)}
                            running={running}
                            onRetry={() => void retrySlot(slot.id)}
                            onDownload={() => void run(async () => (await downloadSlotOriginal(slot, index), t("ecommerceSet.downloadedOriginal")))}
                        />
                    ))}
                </div>
            ) : (
                <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 text-center dark:border-stone-700 lg:min-h-[560px]">
                    <ShoppingBag className="mb-4 size-11 text-stone-400" />
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("ecommerceSet.emptyResults")} />
                </div>
            )}
        </>
    );
}

function ReviewSummary({ record }: { record: EcommerceSetRecord }) {
    const { t } = useTranslation();
    const review = record.review;
    if (!review || review.status === "failed") return null;
    const manual = review.slots.filter((slot) => slot.status === "manual_review");

    return (
        <div className="mb-4 rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-900">
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{t("ecommerceSet.reviewResult")}</span>
                <Tag className="m-0" color={review.status === "passed" ? "green" : "orange"}>
                    {t(`ecommerceSet.reviewStatus.${review.status}`)}
                </Tag>
                {review.batches > 1 ? <Tag className="m-0">{t("ecommerceSet.batchedReview", { count: review.batches })}</Tag> : null}
                {review.requestBytes ? <Tag className="m-0">{t("ecommerceSet.reviewRequestBytes", { size: formatBytes(review.requestBytes) })}</Tag> : null}
            </div>
            {review.summary ? <Typography.Paragraph className="!mb-0 mt-2 !text-xs !text-stone-600 dark:!text-stone-300">{review.summary}</Typography.Paragraph> : null}
            {manual.length ? <div className="mt-2 text-xs text-stone-500 dark:text-stone-400">{t("ecommerceSet.manualReviewHint", { shots: manual.map((slot) => shotRoleLabel(slot.slotId)).join(", ") })}</div> : null}
        </div>
    );
}

function SlotCard({ slot, index, reviewSlot, running, onRetry, onDownload }: { slot: EcommerceSetSlot; index: number; reviewSlot?: EcommerceReviewSlot; running: boolean; onRetry: () => void; onDownload: () => void }) {
    const { t } = useTranslation();
    const failed = slot.status === "generation_failed";
    const canRetry = failed || Boolean(slot.storageKey);
    const retryLabel = failed ? t("workbench.retry") : t("ecommerceSet.regenerate");

    return (
        <div className={`overflow-hidden rounded-lg border bg-background ${failed ? "border-red-200 dark:border-red-950" : "border-stone-200 dark:border-stone-800"}`}>
            {slot.url ? (
                <Image src={slot.url} alt={shotRoleLabel(slot.id)} className="aspect-square object-cover" />
            ) : (
                <div className="relative flex aspect-square flex-col items-center justify-center gap-2 border-b border-dashed border-stone-300 bg-stone-50 text-sm text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400">
                    {slot.status === "generating" ? <LoaderCircle className="size-6 animate-spin" /> : null}
                    <span>{failed ? t("workbench.failed") : slotStatusLabel(slot.status)}</span>
                    {failed && slot.error ? (
                        <Typography.Paragraph ellipsis={{ rows: 3 }} className="!mb-0 px-4 !text-center !text-xs !text-red-500 dark:!text-red-300">
                            {slot.error}
                        </Typography.Paragraph>
                    ) : null}
                </div>
            )}
            <div className="space-y-2 px-3 py-2.5">
                <div className="flex min-w-0 items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold">
                        {index + 1}. {shotRoleLabel(slot.id)}
                    </span>
                    <Tag className="m-0 shrink-0" color={slot.status === "passed" ? "green" : slot.status === "manual_review" ? "orange" : failed ? "red" : undefined}>
                        {slotStatusLabel(slot.status)}
                    </Tag>
                </div>
                <div className="flex min-w-0 flex-wrap gap-x-2 text-xs text-stone-500 dark:text-stone-400">
                    {slot.generationConfig ? <span>{modelOptionName(slot.generationConfig.imageModel || slot.generationConfig.model)} · {imageSizeLabel(slot.generationConfig.size)} · {imageQualityLabel(slot.generationConfig.quality)}</span> : null}
                    {slot.naturalWidth && slot.naturalHeight ? (
                        <span>
                            {slot.naturalWidth}x{slot.naturalHeight}
                        </span>
                    ) : null}
                    {slot.bytes ? <span>{formatBytes(slot.bytes)}</span> : null}
                    {slot.durationMs ? <span>{formatDuration(slot.durationMs)}</span> : null}
                    {slot.attempts > 1 ? <span>{t("ecommerceSet.attempts", { count: slot.attempts })}</span> : null}
                </div>
                {reviewSlot ? <SlotChecks reviewSlot={reviewSlot} /> : null}
                <div className="flex gap-2">
                    <Tooltip title={t("ecommerceSet.downloadOriginal")}>
                        <Button className="min-w-0 flex-1 px-1.5" size="small" icon={<Download className="size-3.5" />} disabled={!slot.storageKey} onClick={onDownload}>
                            {t("ecommerceSet.downloadOriginal")}
                        </Button>
                    </Tooltip>
                    {canRetry ? (
                        <Button className="min-w-0 flex-1 px-1.5" size="small" danger={failed} icon={<RefreshCw className="size-3.5" />} loading={slot.status === "generating"} disabled={running || !slot.enabled || !slot.prompt.trim()} onClick={onRetry}>
                            {retryLabel}
                        </Button>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

/** Checks use an icon plus text, so status never depends on colour alone. */
function SlotChecks({ reviewSlot }: { reviewSlot: EcommerceReviewSlot }) {
    const { t } = useTranslation();
    const checks: Array<[string, boolean]> = [
        [t("ecommerceSet.checks.productConsistency"), reviewSlot.checks.productConsistency],
        [t("ecommerceSet.checks.materialAccuracy"), reviewSlot.checks.materialAccuracy],
        [t("ecommerceSet.checks.composition"), reviewSlot.checks.composition],
        [t("ecommerceSet.checks.textAccuracy"), reviewSlot.checks.textAccuracy],
    ];

    return (
        <div className="space-y-1 rounded-md border border-stone-200 px-2 py-1.5 dark:border-stone-800">
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                {checks.map(([label, passed]) => (
                    <span key={label} className={`flex items-center gap-1 ${passed ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
                        {passed ? <Check className="size-3" /> : <X className="size-3" />}
                        {label}
                    </span>
                ))}
            </div>
            {reviewSlot.issues.length ? (
                <ul className="m-0 list-disc pl-4 text-xs text-stone-500 dark:text-stone-400">
                    {reviewSlot.issues.map((issue) => (
                        <li key={issue}>{issue}</li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}
