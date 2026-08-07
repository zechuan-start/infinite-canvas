import { CheckSquare, Plus, Trash2 } from "lucide-react";
import { Button, Checkbox, Tag } from "antd";
import { useTranslation } from "react-i18next";

import { setStatusLabel } from "@/lib/ecommerce-set/presets";
import { deliverableSlots } from "@/lib/ecommerce-set/delivery";
import type { EcommerceSetRecord } from "@/types/image";

export function EcommerceSetHistory({
    records,
    selectedIds,
    activeId,
    onSelectedIdsChange,
    onCreate,
    onDeleteSelected,
    onOpen,
}: {
    records: EcommerceSetRecord[];
    selectedIds: string[];
    activeId?: string;
    onSelectedIdsChange: (ids: string[]) => void;
    onCreate: () => void;
    onDeleteSelected: () => void;
    onOpen: (record: EcommerceSetRecord) => void;
}) {
    const { t } = useTranslation();
    const allSelected = Boolean(records.length) && selectedIds.length === records.length;

    return (
        <>
            <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold">{t("ecommerceSet.tasks")}</h2>
                <Tag className="m-0">{records.length}</Tag>
            </div>
            <div className="mb-4 flex flex-wrap gap-2">
                <Button size="small" icon={<Plus className="size-3.5" />} onClick={onCreate}>
                    {t("ecommerceSet.newTask")}
                </Button>
                <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!records.length} onClick={() => onSelectedIdsChange(allSelected ? [] : records.map((record) => record.id))}>
                    {allSelected ? t("common.cancel") : t("workbench.selectAll")}
                </Button>
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedIds.length} onClick={onDeleteSelected}>
                    {t("common.delete")}
                </Button>
            </div>
            <div className="space-y-3">
                {records.map((record) => (
                    <SetCard
                        key={record.id}
                        record={record}
                        selected={selectedIds.includes(record.id)}
                        active={activeId === record.id}
                        onSelectedChange={(checked) => onSelectedIdsChange(checked ? [...selectedIds, record.id] : selectedIds.filter((id) => id !== record.id))}
                        onClick={() => onOpen(record)}
                    />
                ))}
                {!records.length ? <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-stone-300 text-center text-sm text-stone-500 dark:border-stone-700">{t("ecommerceSet.noTasks")}</div> : null}
            </div>
        </>
    );
}

function SetCard({ record, selected, active, onSelectedChange, onClick }: { record: EcommerceSetRecord; selected: boolean; active: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void }) {
    const { t } = useTranslation();
    const deliverables = deliverableSlots(record);
    const thumbnails = deliverables
        .map((slot) => slot.url)
        .filter((url): url is string => Boolean(url))
        .slice(0, 4);
    const enabled = record.slots.filter((slot) => slot.enabled).length;

    return (
        <button
            type="button"
            className={`block w-full rounded-lg border p-2 text-left transition ${active ? "border-stone-900 bg-blue-50 dark:border-stone-100 dark:bg-blue-950/20" : "border-stone-200 bg-background hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"}`}
            onClick={onClick}
        >
            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
                <Checkbox className="mt-0.5" checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelectedChange(event.target.checked)} />
                <div className="min-w-0">
                    <div className="truncate text-sm font-semibold leading-5">{record.title}</div>
                    {thumbnails.length ? (
                        <div className="mt-2 flex gap-1 overflow-hidden">
                            {thumbnails.map((url, index) => (
                                <img key={`${record.id}-${index}`} src={url} alt="" className="size-8 shrink-0 rounded-md object-cover" />
                            ))}
                        </div>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{setStatusLabel(record.status)}</Tag>
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="blue">
                            {t("ecommerceSet.progressCount", { done: deliverables.length, total: enabled })}
                        </Tag>
                        {record.review && record.review.status !== "failed" ? (
                            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color={record.review.status === "passed" ? "green" : "orange"}>
                                {t(`ecommerceSet.reviewStatus.${record.review.status}`)}
                            </Tag>
                        ) : null}
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{record.time}</Tag>
                    </div>
                </div>
            </div>
        </button>
    );
}
