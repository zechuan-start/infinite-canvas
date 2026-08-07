import i18n from "@/i18n";

export type CompressedImage = {
    blob: Blob;
    width: number;
    height: number;
    mimeType: string;
    bytes: number;
};

const REVIEW_QUALITY = 0.8;
let webpSupport: boolean | null = null;

/**
 * Compress one generated image for a vision-review upload only.
 *
 * Keeps the original pixel dimensions and never touches the stored original. WebP is preferred; JPEG is
 * used only when WebP is unavailable and the image is fully opaque, so a transparent image is never
 * flattened onto a background. Any failure throws, because the caller must block the review rather than
 * quietly fall back to uploading the uncompressed original.
 */
export async function compressForVisionReview(source: Blob, quality = REVIEW_QUALITY): Promise<CompressedImage> {
    const bitmap = await createImageBitmap(source).catch(() => {
        throw new Error(i18n.t("ecommerceSet.errors.compressDecodeFailed"));
    });
    try {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error(i18n.t("ecommerceSet.errors.compressCanvasFailed"));
        context.drawImage(bitmap, 0, 0);
        const mimeType = resolveReviewMimeType(context, canvas.width, canvas.height);
        const blob = await canvasToBlob(canvas, mimeType, quality);
        return { blob, width: canvas.width, height: canvas.height, mimeType: blob.type || mimeType, bytes: blob.size };
    } finally {
        bitmap.close();
    }
}

function resolveReviewMimeType(context: CanvasRenderingContext2D, width: number, height: number) {
    if (supportsWebp()) return "image/webp";
    if (hasTransparentPixel(context, width, height)) throw new Error(i18n.t("ecommerceSet.errors.compressTransparentUnsupported"));
    return "image/jpeg";
}

function supportsWebp() {
    if (webpSupport !== null) return webpSupport;
    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    webpSupport = probe.toDataURL("image/webp").startsWith("data:image/webp");
    return webpSupport;
}

function hasTransparentPixel(context: CanvasRenderingContext2D, width: number, height: number) {
    const { data } = context.getImageData(0, 0, width, height);
    for (let index = 3; index < data.length; index += 4) {
        if (data[index] < 255) return true;
    }
    return false;
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number) {
    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(i18n.t("ecommerceSet.errors.compressEncodeFailed")))), mimeType, quality);
    });
}
