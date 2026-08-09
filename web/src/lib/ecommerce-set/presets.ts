import i18n from "@/i18n";
import type { EcommerceReferenceRole, EcommerceSetSlot, EcommerceShotRole, ShotDescriptor } from "@/types/ecommerce-set";

export const CUSTOM_STYLE_PRESET_ID = "custom";

/** Visual style presets. `style` is model-facing text; `label` is UI copy. */
export const STYLE_PRESETS = [
    {
        id: "studio-clean",
        get label() {
            return i18n.t("ecommerceSet.styles.studioClean");
        },
        get style() {
            return i18n.t("ecommerceSet.styles.studioCleanText");
        },
    },
    {
        id: "lifestyle-warm",
        get label() {
            return i18n.t("ecommerceSet.styles.lifestyleWarm");
        },
        get style() {
            return i18n.t("ecommerceSet.styles.lifestyleWarmText");
        },
    },
    {
        id: "premium-dark",
        get label() {
            return i18n.t("ecommerceSet.styles.premiumDark");
        },
        get style() {
            return i18n.t("ecommerceSet.styles.premiumDarkText");
        },
    },
    {
        id: "ecommerce-bright",
        get label() {
            return i18n.t("ecommerceSet.styles.ecommerceBright");
        },
        get style() {
            return i18n.t("ecommerceSet.styles.ecommerceBrightText");
        },
    },
    {
        id: "outdoor-natural",
        get label() {
            return i18n.t("ecommerceSet.styles.outdoorNatural");
        },
        get style() {
            return i18n.t("ecommerceSet.styles.outdoorNaturalText");
        },
    },
    {
        id: CUSTOM_STYLE_PRESET_ID,
        get label() {
            return i18n.t("ecommerceSet.styles.custom");
        },
        style: "",
    },
];

/** The six built-in shots that make up a new set. `brief` tells the planning model what this shot must deliver. */
export const SHOT_TEMPLATES: Array<{ id: EcommerceShotRole; brief: string }> = [
    {
        id: "hero",
        get brief() {
            return i18n.t("ecommerceSet.shots.heroBrief");
        },
    },
    {
        id: "material",
        get brief() {
            return i18n.t("ecommerceSet.shots.materialBrief");
        },
    },
    {
        id: "scene",
        get brief() {
            return i18n.t("ecommerceSet.shots.sceneBrief");
        },
    },
    {
        id: "feature",
        get brief() {
            return i18n.t("ecommerceSet.shots.featureBrief");
        },
    },
    {
        id: "packaging",
        get brief() {
            return i18n.t("ecommerceSet.shots.packagingBrief");
        },
    },
    {
        id: "closing",
        get brief() {
            return i18n.t("ecommerceSet.shots.closingBrief");
        },
    },
];

export const REFERENCE_ROLES: EcommerceReferenceRole[] = ["main", "packaging", "detail", "size", "other"];

/** Roles a user may add a shot for. `custom` carries its own label and brief instead of a template. */
export const SHOT_ROLES: EcommerceShotRole[] = [...SHOT_TEMPLATES.map((template) => template.id), "custom"];

export function stylePresetById(id: string) {
    return STYLE_PRESETS.find((item) => item.id === id);
}

/** Resolved style text: a custom description wins, otherwise the selected preset's text. */
export function resolveStyleText(stylePresetId: string, customStyle: string) {
    const custom = customStyle.trim();
    if (stylePresetId === CUSTOM_STYLE_PRESET_ID) return custom;
    return [stylePresetById(stylePresetId)?.style || "", custom].filter(Boolean).join("\n");
}

export function stylePresetLabel(id: string) {
    return stylePresetById(id)?.label || i18n.t("ecommerceSet.styles.custom");
}

export function shotRoleLabel(role: EcommerceShotRole) {
    return i18n.t(`ecommerceSet.shots.${role}`);
}

export function shotBrief(role: EcommerceShotRole) {
    return SHOT_TEMPLATES.find((item) => item.id === role)?.brief || "";
}

/** Display name of one slot: an explicit label wins, otherwise the role label. */
export function slotLabel(slot: Pick<EcommerceSetSlot, "role" | "label">) {
    return slot.label?.trim() || shotRoleLabel(slot.role);
}

/** What the planning and review models are told about one slot. */
export function slotDescriptor(slot: Pick<EcommerceSetSlot, "id" | "role" | "label" | "brief">): ShotDescriptor {
    return { id: slot.id, role: slot.role, label: slotLabel(slot), brief: slot.brief?.trim() || shotBrief(slot.role) };
}

/** Keyword hints per reference role, matched against the uploaded file name. Localized so both languages work. */
function referenceRoleHints(): Array<{ role: EcommerceReferenceRole; keywords: string[] }> {
    return (["main", "packaging", "detail", "size"] as const).map((role) => ({
        role,
        keywords: i18n
            .t(`ecommerceSet.referenceRoleHints.${role}`)
            .split(",")
            .map((keyword) => keyword.trim().toLowerCase())
            .filter(Boolean),
    }));
}

/**
 * Initial role for an uploaded reference: the first image is the main shot, the rest are guessed from the
 * file name and fall back to `detail`. The user can always override it.
 */
export function guessReferenceRole(name: string, isFirst: boolean): EcommerceReferenceRole {
    if (isFirst) return "main";
    const haystack = name.toLowerCase();
    return referenceRoleHints().find((hint) => hint.keywords.some((keyword) => haystack.includes(keyword)))?.role || "detail";
}

export function referenceRoleLabel(role: EcommerceReferenceRole) {
    return i18n.t(`ecommerceSet.referenceRoles.${role}`);
}

export function setStatusLabel(status: string) {
    return i18n.t(`ecommerceSet.status.${status}`);
}

export function slotStatusLabel(status: string) {
    return i18n.t(`ecommerceSet.slotStatus.${status}`);
}
