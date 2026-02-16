/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 alrn
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

const DEFAULT_AZURE_ENDPOINT = "https://api.cognitive.microsofttranslator.com";

function buildAzureTranslateUrl(endpoint: string, targetLanguage: string): string {
    const normalized = (endpoint?.trim() || DEFAULT_AZURE_ENDPOINT).replace(/\/+$/, "");
    const lower = normalized.toLowerCase();

    const hasTranslatorPath = lower.includes("/translator/text/v3.0");
    const isCustomResourceEndpoint = lower.includes(".cognitiveservices.azure.com");

    const base = hasTranslatorPath
        ? normalized
        : isCustomResourceEndpoint
            ? `${normalized}/translator/text/v3.0`
            : normalized;

    const url = new URL(`${base}/translate`);
    url.searchParams.set("api-version", "3.0");
    url.searchParams.set("to", targetLanguage);
    return url.toString();
}

export async function makeAzureTranslateRequest(
    _: IpcMainInvokeEvent,
    endpoint: string,
    apiKey: string,
    region: string,
    targetLanguage: string,
    text: string
) {
    try {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "Ocp-Apim-Subscription-Key": apiKey
        };

        if (region?.trim()) {
            headers["Ocp-Apim-Subscription-Region"] = region.trim();
        }

        const response = await fetch(buildAzureTranslateUrl(endpoint, targetLanguage), {
            method: "POST",
            headers,
            body: JSON.stringify([{ Text: text }])
        });

        return {
            status: response.status,
            data: await response.text()
        };
    } catch (error) {
        return {
            status: -1,
            data: String(error)
        };
    }
}
