/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 alrn
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { addMessageAccessory, removeMessageAccessory } from "@api/MessageAccessories";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { UserStore, useEffect, useState } from "@webpack/common";

const enum BackendMode {
    AzureGoogleFallback = "azure-google-fallback",
    AzureOnly = "azure-only",
    GoogleOnly = "google-only"
}

interface TranslationValue {
    sourceLanguage: string;
    text: string;
}

interface GoogleTranslateResponse {
    sourceLanguage: string;
    translation: string;
}

interface AzureTranslateResponseItem {
    detectedLanguage?: {
        language?: string;
        score?: number;
    };
    translations?: Array<{
        text?: string;
        to?: string;
    }>;
}

interface AzureErrorResponse {
    error?: {
        code?: string | number;
        message?: string;
    };
}

interface PersistentTranslationEntry {
    normalizedSource: string;
    translatedText: string;
    sourceLanguage: string;
    cachedAt: number;
    lastUsedAt: number;
}

const Native = VencordNative.pluginHelpers.Lingo as PluginNative<typeof import("./native")>;

type TranslationState =
    | { status: "idle"; }
    | { status: "pending"; }
    | { status: "ready"; sourceLanguage: string; text: string; }
    | { status: "error"; message: string; };

const PLUGIN_ID = "Lingo";
const DEFAULT_AZURE_ENDPOINT = "https://api.cognitive.microsofttranslator.com";
const DEFAULT_TARGET_LANGUAGE = "sv";
const PERSISTENT_CACHE_DATASTORE_KEY = "Lingo_translationMemory_v1";
const LEGACY_PERSISTENT_CACHE_DATASTORE_KEYS = [
    "LanguageLearningImmersion_translationMemory_v1",
    "AutoSwedishImmersion_translationMemory_v1"
];
const translationCache = new Map<string, TranslationState>();
const inFlightRequests = new Map<string, Promise<TranslationState>>();
const persistentTranslationMemory = new Map<string, PersistentTranslationEntry>();
const originalMessageHtml = new Map<string, string>();
const requestQueue: Array<() => void> = [];
let activeRequests = 0;
let persistentCacheLoaded = false;
let persistentCacheLoadPromise: Promise<void> | null = null;
let persistMemoryTimer: ReturnType<typeof setTimeout> | null = null;

function clearTranslationCaches() {
    translationCache.clear();
    inFlightRequests.clear();
    requestQueue.length = 0;
    activeRequests = 0;
}

function invalidateAllTranslations() {
    clearTranslationCaches();

    for (const messageId of originalMessageHtml.keys()) {
        restoreOriginalMessage(messageId);
    }

    originalMessageHtml.clear();
}

const settings = definePluginSettings({
    targetLanguage: {
        type: OptionType.STRING,
        description: "Language you are practicing (ISO 639-1). Examples: sv, es, fr, de, ja",
        default: DEFAULT_TARGET_LANGUAGE,
        placeholder: DEFAULT_TARGET_LANGUAGE,
        onChange: invalidateAllTranslations
    },
    translationBackend: {
        type: OptionType.SELECT,
        description: "Translation engine used for language-learning mode",
        options: [
            { label: "Azure + Google fallback", value: BackendMode.AzureGoogleFallback, default: true },
            { label: "Azure only", value: BackendMode.AzureOnly },
            { label: "Google only", value: BackendMode.GoogleOnly }
        ],
        onChange: invalidateAllTranslations
    },
    azureApiKey: {
        type: OptionType.STRING,
        description: "Azure Translator API key for your learning translations (stored locally in Vencord settings)",
        default: "",
        placeholder: "Paste your Azure Translator key",
        disabled: () => settings.store.translationBackend === BackendMode.GoogleOnly,
        onChange: invalidateAllTranslations
    },
    azureRegion: {
        type: OptionType.STRING,
        description: "Azure Translator resource region (for example: swedencentral, westeurope)",
        default: "",
        placeholder: "swedencentral",
        disabled: () => settings.store.translationBackend === BackendMode.GoogleOnly,
        onChange: invalidateAllTranslations
    },
    azureEndpoint: {
        type: OptionType.STRING,
        description: "Azure Translator endpoint for your resource",
        default: DEFAULT_AZURE_ENDPOINT,
        placeholder: DEFAULT_AZURE_ENDPOINT,
        disabled: () => settings.store.translationBackend === BackendMode.GoogleOnly,
        onChange: invalidateAllTranslations
    },
    onlyTranslateVisible: {
        type: OptionType.BOOLEAN,
        description: "Only translate messages currently visible on screen (faster and cheaper)",
        default: true
    },
    maxConcurrentRequests: {
        type: OptionType.SLIDER,
        description: "Maximum simultaneous translation requests",
        default: 4,
        markers: [1, 2, 3, 4, 5, 6, 7, 8]
    },
    persistentCacheEnabled: {
        type: OptionType.BOOLEAN,
        description: "Reuse previous learning translations across messages/restarts",
        default: true
    },
    persistentCacheTtlDays: {
        type: OptionType.SLIDER,
        description: "How long saved translations stay valid in learning memory",
        default: 30,
        markers: [1, 3, 7, 14, 30, 60, 90]
    },
    persistentCacheMaxEntries: {
        type: OptionType.SLIDER,
        description: "Maximum saved translation-memory entries",
        default: 1000,
        markers: [100, 250, 500, 1000, 2500, 5000]
    }
});

let languageNames: Intl.DisplayNames | null = null;

function normalizeTargetLanguage(targetLanguage: string | undefined): string {
    return (targetLanguage?.trim() || DEFAULT_TARGET_LANGUAGE).toLowerCase();
}

function getTargetLanguageDisplayName(targetLanguage: string | undefined): string {
    const normalized = normalizeTargetLanguage(targetLanguage);

    try {
        languageNames ??= new Intl.DisplayNames(["en"], { type: "language" });
        return (languageNames.of(normalized) || normalized).toLowerCase();
    } catch {
        return normalized;
    }
}

function normalizeTextForMemory(text: string): string {
    return text.trim().replace(/\s+/g, " ");
}

function hashText(input: string): string {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

function makePersistentMemoryKey(text: string, translatorConfigFingerprint: string): string {
    const normalized = normalizeTextForMemory(text);
    return `${translatorConfigFingerprint}:${normalized.length}:${hashText(normalized)}`;
}

function getPersistentCacheTtlMs(): number {
    return settings.store.persistentCacheTtlDays * 24 * 60 * 60 * 1000;
}

function isPersistentEntryExpired(entry: PersistentTranslationEntry, now = Date.now()): boolean {
    return now - entry.cachedAt > getPersistentCacheTtlMs();
}

function prunePersistentMemory() {
    const now = Date.now();

    for (const [key, entry] of persistentTranslationMemory) {
        if (isPersistentEntryExpired(entry, now)) {
            persistentTranslationMemory.delete(key);
        }
    }

    const maxEntries = settings.store.persistentCacheMaxEntries;
    if (persistentTranslationMemory.size <= maxEntries) return;

    const overflow = persistentTranslationMemory.size - maxEntries;
    const oldestEntries = [...persistentTranslationMemory.entries()]
        .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
        .slice(0, overflow);

    for (const [key] of oldestEntries) {
        persistentTranslationMemory.delete(key);
    }
}

async function persistMemoryNow() {
    if (!settings.store.persistentCacheEnabled) return;

    prunePersistentMemory();
    await DataStore.set(PERSISTENT_CACHE_DATASTORE_KEY, [...persistentTranslationMemory.entries()]);
}

function schedulePersistentMemorySave() {
    if (!settings.store.persistentCacheEnabled) return;

    if (persistMemoryTimer) {
        clearTimeout(persistMemoryTimer);
    }

    persistMemoryTimer = setTimeout(() => {
        persistMemoryTimer = null;
        void persistMemoryNow();
    }, 2000);
}

async function ensurePersistentMemoryLoaded() {
    if (!settings.store.persistentCacheEnabled) return;
    if (persistentCacheLoaded) return;
    if (persistentCacheLoadPromise) return persistentCacheLoadPromise;

    persistentCacheLoadPromise = (async () => {
        try {
            const loadCache = async (cacheKey: string): Promise<boolean> => {
                const cached = await DataStore.get<Array<[string, PersistentTranslationEntry]>>(cacheKey);
                if (!Array.isArray(cached)) return false;

                let loadedAny = false;
                for (const [key, entry] of cached) {
                    if (!entry?.normalizedSource || !entry?.translatedText || !entry?.sourceLanguage) continue;
                    persistentTranslationMemory.set(key, entry);
                    loadedAny = true;
                }

                return loadedAny;
            };

            const hasCurrentCache = await loadCache(PERSISTENT_CACHE_DATASTORE_KEY);

            if (!hasCurrentCache) {
                for (const legacyKey of LEGACY_PERSISTENT_CACHE_DATASTORE_KEYS) {
                    if (await loadCache(legacyKey)) {
                        schedulePersistentMemorySave();
                        break;
                    }
                }
            }

            prunePersistentMemory();
        } catch {
            // Ignore corrupted/unavailable local cache and continue with empty memory.
        } finally {
            persistentCacheLoaded = true;
            persistentCacheLoadPromise = null;
        }
    })();

    return persistentCacheLoadPromise;
}

async function tryGetPersistentTranslation(text: string, translatorConfigFingerprint: string): Promise<TranslationState | null> {
    if (!settings.store.persistentCacheEnabled) return null;

    await ensurePersistentMemoryLoaded();

    const normalized = normalizeTextForMemory(text);
    if (!normalized) return null;

    const key = makePersistentMemoryKey(text, translatorConfigFingerprint);
    const entry = persistentTranslationMemory.get(key);
    if (!entry) return null;
    if (entry.normalizedSource !== normalized) return null;
    if (isPersistentEntryExpired(entry)) {
        persistentTranslationMemory.delete(key);
        schedulePersistentMemorySave();
        return null;
    }

    entry.lastUsedAt = Date.now();
    persistentTranslationMemory.set(key, entry);
    schedulePersistentMemorySave();

    return {
        status: "ready",
        sourceLanguage: entry.sourceLanguage,
        text: entry.translatedText
    };
}

function rememberPersistentTranslation(text: string, translatorConfigFingerprint: string, state: TranslationState) {
    if (!settings.store.persistentCacheEnabled) return;
    if (state.status !== "ready") return;

    const normalized = normalizeTextForMemory(text);
    if (!normalized) return;

    const now = Date.now();
    const key = makePersistentMemoryKey(text, translatorConfigFingerprint);

    persistentTranslationMemory.set(key, {
        normalizedSource: normalized,
        translatedText: state.text,
        sourceLanguage: state.sourceLanguage,
        cachedAt: now,
        lastUsedAt: now
    });

    prunePersistentMemory();
    schedulePersistentMemorySave();
}

function normalizeAzureEndpoint(endpoint: string | undefined): string {
    const raw = endpoint?.trim() || DEFAULT_AZURE_ENDPOINT;
    return raw.replace(/\/+$/, "");
}

function hasAzureConfig() {
    return Boolean(settings.store.azureApiKey?.trim());
}

function getTranslatorConfigFingerprint(): string {
    const hasKey = settings.store.azureApiKey?.trim() ? "with-key" : "no-key";
    return [
        normalizeTargetLanguage(settings.store.targetLanguage),
        settings.store.translationBackend,
        normalizeAzureEndpoint(settings.store.azureEndpoint),
        settings.store.azureRegion?.trim().toLowerCase() || "",
        hasKey
    ].join("|");
}

function getMessageCacheKey(message: Message, translatorConfigFingerprint = getTranslatorConfigFingerprint()): string {
    return `${message.id}:${message.content ?? ""}:${translatorConfigFingerprint}`;
}

function shouldTranslateMessage(message: Message): boolean {
    if (!message.content?.trim()) return false;
    if (!shouldTranslateContent(message.content)) return false;

    const currentUserId = UserStore.getCurrentUser()?.id;
    if (!currentUserId) return true;

    return message.author?.id !== currentUserId;
}

function shouldTranslateContent(content: string): boolean {
    const trimmed = content.trim();
    if (trimmed.length < 2) return false;

    // Skip emoji/symbol/punctuation-only messages.
    return /[\p{Letter}\p{Number}]/u.test(trimmed);
}

async function fetchGoogleTranslation(text: string, targetLanguage: string): Promise<TranslationValue> {
    const url = "https://translate-pa.googleapis.com/v1/translate?" + new URLSearchParams({
        "params.client": "gtx",
        "dataTypes": "TRANSLATION",
        "key": "AIzaSyDLEeFI5OtFBwYBIoK_jj5m32rZK5CkCXA",
        "query.sourceLanguage": "auto",
        "query.targetLanguage": targetLanguage,
        "query.text": text
    });

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Translate request failed: ${response.status} ${response.statusText}`);
        }

        const data: GoogleTranslateResponse = await response.json();

        return {
            sourceLanguage: data.sourceLanguage || "auto",
            text: data.translation || text
        };
    } catch (error) {
        throw new Error(error instanceof Error ? error.message : "Google translation failed");
    }
}

async function fetchAzureTranslation(text: string, targetLanguage: string): Promise<TranslationValue> {
    const apiKey = settings.store.azureApiKey?.trim();
    const region = settings.store.azureRegion?.trim();

    if (!apiKey) {
        throw new Error("Azure key is missing in plugin settings");
    }

    const endpoint = normalizeAzureEndpoint(settings.store.azureEndpoint);
    if (!Native?.makeAzureTranslateRequest) {
        throw new Error("native helper unavailable (rebuild + reinject Vencord)");
    }

    const { status, data } = await Native.makeAzureTranslateRequest(
        endpoint,
        apiKey,
        region || "",
        targetLanguage,
        text
    );

    if (status < 200 || status >= 300) {
        const errorText = data ?? "";
        let azureMessage = "";

        try {
            const parsed = JSON.parse(errorText) as AzureErrorResponse;
            azureMessage = parsed.error?.message?.trim() || "";
        } catch {
            azureMessage = errorText.trim();
        }

        const statusPart = status === -1 ? "-1 network/request failure" : String(status);
        const detail = azureMessage ? ` - ${azureMessage}` : "";
        throw new Error(`Azure translation failed (${statusPart})${detail}`.trim());
    }

    const parsedData = JSON.parse(data) as AzureTranslateResponseItem[];
    const first = parsedData[0];

    const translatedText =
        first?.translations?.find(t => t.to === targetLanguage)?.text
        ?? first?.translations?.[0]?.text;

    if (!translatedText) {
        throw new Error("Azure translation response did not include translated text");
    }

    return {
        sourceLanguage: first?.detectedLanguage?.language || "auto",
        text: translatedText
    };
}

async function fetchTranslation(text: string, targetLanguage: string): Promise<TranslationState> {
    const backendMode = settings.store.translationBackend;
    const wrapReady = (value: TranslationValue): TranslationState => ({
        status: "ready",
        sourceLanguage: value.sourceLanguage,
        text: value.text
    });

    if (backendMode === BackendMode.GoogleOnly) {
        try {
            return wrapReady(await fetchGoogleTranslation(text, targetLanguage));
        } catch {
            return { status: "error", message: "translation unavailable" };
        }
    }

    const azureConfigured = hasAzureConfig();
    if (!azureConfigured && backendMode === BackendMode.AzureOnly) {
        return { status: "error", message: "set azure key in plugin settings" };
    }

    if (azureConfigured) {
        try {
            return wrapReady(await fetchAzureTranslation(text, targetLanguage));
        } catch (error) {
            if (backendMode === BackendMode.AzureOnly) {
                const message = error instanceof Error ? error.message : "azure translation failed";
                return { status: "error", message };
            }
        }
    }

    try {
        return wrapReady(await fetchGoogleTranslation(text, targetLanguage));
    } catch {
        return { status: "error", message: "translation unavailable" };
    }
}

function scheduleTranslation<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        const run = () => {
            activeRequests++;

            task()
                .then(resolve, reject)
                .finally(() => {
                    activeRequests--;
                    requestQueue.shift()?.();
                });
        };

        if (activeRequests < settings.store.maxConcurrentRequests) {
            run();
        } else {
            requestQueue.push(run);
        }
    });
}

function requestTranslation(message: Message, translatorConfigFingerprint: string): Promise<TranslationState> {
    const key = getMessageCacheKey(message, translatorConfigFingerprint);

    const cached = translationCache.get(key);
    if (cached) return Promise.resolve(cached);

    const currentRequest = inFlightRequests.get(key);
    if (currentRequest) return currentRequest;

    const request = (async () => {
        const messageText = message.content ?? "";
        const targetLanguage = normalizeTargetLanguage(settings.store.targetLanguage);

        const persistentHit = await tryGetPersistentTranslation(messageText, translatorConfigFingerprint);
        if (persistentHit) return persistentHit;

        const result = await scheduleTranslation(() => fetchTranslation(messageText, targetLanguage));
        rememberPersistentTranslation(messageText, translatorConfigFingerprint, result);
        return result;
    })().then(result => {
        translationCache.set(key, result);
        inFlightRequests.delete(key);
        return result;
    });

    inFlightRequests.set(key, request);
    return request;
}

function getMessageNode(messageId: string) {
    return document.getElementById(`message-content-${messageId}`) as HTMLElement | null;
}

function restoreOriginalMessage(messageId: string) {
    const messageNode = getMessageNode(messageId);
    if (!messageNode) return;

    const original = originalMessageHtml.get(messageId);
    if (!original) return;

    if (messageNode.dataset.vcLingoTranslated === "true" || messageNode.dataset.vcAutoSwedishTranslated === "true") {
        messageNode.innerHTML = original;
        delete messageNode.dataset.vcLingoTranslated;
        delete messageNode.dataset.vcAutoSwedishTranslated;
    }
}

function replaceMessageWithTranslation(messageId: string, translatedText: string) {
    const messageNode = getMessageNode(messageId);
    if (!messageNode) return;

    if (!originalMessageHtml.has(messageId)) {
        originalMessageHtml.set(messageId, messageNode.innerHTML);
    }

    messageNode.textContent = translatedText;
    messageNode.dataset.vcLingoTranslated = "true";
}

function useMessageVisibility(messageId: string): boolean {
    const [isVisible, setVisible] = useState(false);

    useEffect(() => {
        if (!("IntersectionObserver" in window)) {
            setVisible(true);
            return;
        }

        const node = getMessageNode(messageId);
        if (!node) {
            setVisible(true);
            return;
        }

        const observer = new IntersectionObserver(entries => {
            setVisible(entries.some(entry => entry.isIntersecting));
        });

        observer.observe(node);
        return () => observer.disconnect();
    }, [messageId]);

    return isVisible;
}

function LingoAccessory({ message }: { message: Message; }) {
    const {
        targetLanguage,
        onlyTranslateVisible,
        translationBackend,
        azureApiKey,
        azureRegion,
        azureEndpoint
    } = settings.use(["targetLanguage", "onlyTranslateVisible", "translationBackend", "azureApiKey", "azureRegion", "azureEndpoint"]);
    const targetLanguageCode = normalizeTargetLanguage(targetLanguage);
    const targetLanguageDisplay = getTargetLanguageDisplayName(targetLanguageCode);
    const translatorConfigFingerprint = [
        targetLanguageCode,
        translationBackend,
        normalizeAzureEndpoint(azureEndpoint),
        azureRegion?.trim().toLowerCase() || "",
        azureApiKey?.trim() ? "with-key" : "no-key"
    ].join("|");
    const [showOriginal, setShowOriginal] = useState(false);
    const [translation, setTranslation] = useState<TranslationState>(
        () => translationCache.get(getMessageCacheKey(message, translatorConfigFingerprint)) ?? { status: "idle" }
    );
    const shouldTranslate = shouldTranslateMessage(message);
    const isVisible = useMessageVisibility(message.id);

    useEffect(() => {
        restoreOriginalMessage(message.id);
        originalMessageHtml.delete(message.id);
        setTranslation(translationCache.get(getMessageCacheKey(message, translatorConfigFingerprint)) ?? { status: "idle" });
        setShowOriginal(false);
    }, [message.id, message.content, translatorConfigFingerprint]);

    useEffect(() => {
        return () => {
            restoreOriginalMessage(message.id);
            originalMessageHtml.delete(message.id);
        };
    }, [message.id]);

    useEffect(() => {
        if (!shouldTranslate || (onlyTranslateVisible && !isVisible)) return;

        const key = getMessageCacheKey(message, translatorConfigFingerprint);
        const cached = translationCache.get(key);
        if (cached) {
            setTranslation(cached);
            return;
        }

        setTranslation({ status: "pending" });
        let cancelled = false;

        requestTranslation(message, translatorConfigFingerprint).then(result => {
            if (!cancelled) setTranslation(result);
        });

        return () => {
            cancelled = true;
        };
    }, [message.id, message.content, shouldTranslate, isVisible, onlyTranslateVisible, translatorConfigFingerprint]);

    useEffect(() => {
        if (!shouldTranslate) return;

        if (translation.status === "ready" && !showOriginal) {
            replaceMessageWithTranslation(message.id, translation.text);
            return;
        }

        restoreOriginalMessage(message.id);
    }, [message.id, shouldTranslate, showOriginal, translation]);

    useEffect(() => {
        if (translation.status === "error") {
            setShowOriginal(true);
        }
    }, [translation.status]);

    if (!shouldTranslate) return null;

    const onToggleOriginal = (event: any) => {
        event.preventDefault();
        event.stopPropagation();
        setShowOriginal(v => !v);
    };

    if (translation.status === "idle" || translation.status === "pending") return null;

    if (translation.status === "error") {
            return (
            <span className="vc-lingo">
                <span className="vc-lingo-text vc-lingo-error">{translation.message}</span>
            </span>
        );
    }

    return (
        <span className="vc-lingo">
            <button className="vc-lingo-toggle" onClick={onToggleOriginal}>
                {showOriginal ? `show ${targetLanguageDisplay}` : "view original"}
            </button>
        </span>
    );
}

export default definePlugin({
    name: "Lingo",
    description: "Language-learning immersion plugin that auto-translates incoming messages to your target language.",
    authors: [{ name: "alrn", id: 0n }],
    settings,
    dependencies: ["MessageAccessoriesAPI"],

    start() {
        addMessageAccessory(PLUGIN_ID, ({ message }) => <LingoAccessory message={message} />);
        void ensurePersistentMemoryLoaded();
    },

    stop() {
        removeMessageAccessory(PLUGIN_ID);
        if (persistMemoryTimer) {
            clearTimeout(persistMemoryTimer);
            persistMemoryTimer = null;
        }
        void persistMemoryNow();
        invalidateAllTranslations();
    }
});
