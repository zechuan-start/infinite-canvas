import i18n from "@/i18n";
import type { EcommerceReferenceRole, EcommerceShotRole } from "@/types/ecommerce-set";

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

/** The six built-in shots. `brief` tells the planning model what this shot must deliver. */
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

export function referenceRoleLabel(role: EcommerceReferenceRole) {
    return i18n.t(`ecommerceSet.referenceRoles.${role}`);
}

export function setStatusLabel(status: string) {
    return i18n.t(`ecommerceSet.status.${status}`);
}

export function slotStatusLabel(status: string) {
    return i18n.t(`ecommerceSet.slotStatus.${status}`);
}
