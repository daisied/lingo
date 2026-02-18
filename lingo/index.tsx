/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 alrn
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { addMessageAccessory, removeMessageAccessory } from "@api/MessageAccessories";
import { updateMessage } from "@api/MessageUpdater";
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

type LingoMessage = Message & Record<string, any>;

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
const translatedMessageState = new Map<string, { channelId: string; originalContent: string; translatedContent: string; }>();
const pendingMessageMutations = new Map<string, {
    channelId: string;
    content: string;
    originalContent: string;
    translatedContent: string;
}>();
const requestQueue: Array<() => void> = [];
const visibilitySubscribers = new Map<string, Set<(visible: boolean) => void>>();
const observedMessageNodes = new Map<string, HTMLElement>();
const messageVisibilityState = new Map<string, boolean>();
const MAX_IN_MEMORY_TRANSLATIONS = 2500;
const ORIGINAL_CONTENT_FIELD = "vcLingoOriginalContent";
const TRANSLATED_CONTENT_FIELD = "vcLingoTranslatedContent";
const MESSAGE_MUTATION_FLUSH_BATCH_SIZE = 6;
const MESSAGE_MUTATION_FLUSH_DELAY_MS = 24;
let activeRequests = 0;
let persistentCacheLoaded = false;
let persistentCacheLoadPromise: Promise<void> | null = null;
let persistMemoryTimer: ReturnType<typeof setTimeout> | null = null;
let mutationFlushTimer: ReturnType<typeof setTimeout> | null = null;
let sharedVisibilityObserver: IntersectionObserver | null = null;
const scrollStateSubscribers = new Set<(isScrolling: boolean) => void>();
const SCROLLING_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", "Space"]);
let isScrollActive = false;
let scrollIdleTimer: ReturnType<typeof setTimeout> | null = null;
let windowScrollHandler: ((event: Event) => void) | null = null;
let windowKeydownHandler: ((event: KeyboardEvent) => void) | null = null;
let windowTouchMoveHandler: ((event: TouchEvent) => void) | null = null;

function clearTranslationCaches() {
    translationCache.clear();
    inFlightRequests.clear();
    requestQueue.length = 0;
    activeRequests = 0;
    clearPendingMessageMutations();
}

function setScrollActive(active: boolean) {
    if (isScrollActive === active) return;
    isScrollActive = active;
    for (const subscriber of scrollStateSubscribers) {
        subscriber(active);
    }

    if (!active && pendingMessageMutations.size > 0) {
        scheduleMessageMutationFlush(20);
    }
}

function markScrollActivity() {
    setScrollActive(true);

    if (scrollIdleTimer) {
        clearTimeout(scrollIdleTimer);
    }

    scrollIdleTimer = setTimeout(() => {
        scrollIdleTimer = null;
        setScrollActive(false);
    }, 320);
}

function subscribeToScrollState(onChange: (isScrolling: boolean) => void) {
    scrollStateSubscribers.add(onChange);
    onChange(isScrollActive);

    return () => {
        scrollStateSubscribers.delete(onChange);
    };
}

function pruneInMemoryTranslationCache() {
    while (translationCache.size > MAX_IN_MEMORY_TRANSLATIONS) {
        const oldestKey = translationCache.keys().next().value as string | undefined;
        if (!oldestKey) break;
        translationCache.delete(oldestKey);
    }
}

function clearPendingMessageMutations() {
    pendingMessageMutations.clear();

    if (mutationFlushTimer) {
        clearTimeout(mutationFlushTimer);
        mutationFlushTimer = null;
    }
}

function scheduleMessageMutationFlush(delay = MESSAGE_MUTATION_FLUSH_DELAY_MS) {
    if (mutationFlushTimer) return;

    mutationFlushTimer = setTimeout(() => {
        mutationFlushTimer = null;
        flushPendingMessageMutations();
    }, delay);
}

function flushPendingMessageMutations() {
    if (isScrollActive) {
        scheduleMessageMutationFlush(150);
        return;
    }

    let processed = 0;
    for (const [messageId, mutation] of pendingMessageMutations) {
        pendingMessageMutations.delete(messageId);

        safeUpdateMessage(mutation.channelId, messageId, {
            content: mutation.content,
            [ORIGINAL_CONTENT_FIELD]: mutation.originalContent,
            [TRANSLATED_CONTENT_FIELD]: mutation.translatedContent
        } as any);

        processed++;
        if (processed >= MESSAGE_MUTATION_FLUSH_BATCH_SIZE) break;
    }

    if (pendingMessageMutations.size > 0) {
        scheduleMessageMutationFlush();
    }
}

function enqueueMessageMutation(messageId: string, mutation: {
    channelId: string;
    content: string;
    originalContent: string;
    translatedContent: string;
}) {
    const existing = pendingMessageMutations.get(messageId);
    if (existing
        && existing.channelId === mutation.channelId
        && existing.content === mutation.content
        && existing.originalContent === mutation.originalContent
        && existing.translatedContent === mutation.translatedContent
    ) {
        return;
    }

    pendingMessageMutations.set(messageId, mutation);

    scheduleMessageMutationFlush();
}

function safeUpdateMessage(channelId: string, messageId: string, payload: any) {
    try {
        updateMessage(channelId, messageId, payload);
    } catch {
        // Avoid hard-failing the renderer if Discord internals reject an update.
    }
}

function notifyVisibilitySubscribers(messageId: string, isVisible: boolean) {
    const subscribers = visibilitySubscribers.get(messageId);
    if (!subscribers?.size) return;

    for (const subscriber of subscribers) {
        subscriber(isVisible);
    }
}

function ensureSharedVisibilityObserver() {
    if (sharedVisibilityObserver || !("IntersectionObserver" in window)) return sharedVisibilityObserver;

    sharedVisibilityObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
            const id = (entry.target as HTMLElement).id;
            if (!id.startsWith("message-content-")) continue;

            const messageId = id.slice("message-content-".length);
            const isVisible = entry.isIntersecting;

            if (messageVisibilityState.get(messageId) === isVisible) continue;
            messageVisibilityState.set(messageId, isVisible);
            notifyVisibilitySubscribers(messageId, isVisible);
        }
    });

    return sharedVisibilityObserver;
}

function tryObserveMessageVisibility(messageId: string): boolean {
    const observer = ensureSharedVisibilityObserver();
    if (!observer) return false;

    const node = getMessageNode(messageId);
    if (!node) return false;

    const existing = observedMessageNodes.get(messageId);
    if (existing === node) return true;

    if (existing) {
        observer.unobserve(existing);
    }

    observedMessageNodes.set(messageId, node);
    observer.observe(node);
    return true;
}

function subscribeToMessageVisibility(messageId: string, onChange: (isVisible: boolean) => void) {
    let subscribers = visibilitySubscribers.get(messageId);
    if (!subscribers) {
        subscribers = new Set();
        visibilitySubscribers.set(messageId, subscribers);
    }

    subscribers.add(onChange);
    onChange(messageVisibilityState.get(messageId) ?? false);

    return () => {
        const current = visibilitySubscribers.get(messageId);
        if (!current) return;

        current.delete(onChange);
        if (current.size > 0) return;

        visibilitySubscribers.delete(messageId);

        const observer = ensureSharedVisibilityObserver();
        const observedNode = observedMessageNodes.get(messageId);
        if (observer && observedNode) {
            observer.unobserve(observedNode);
        }

        observedMessageNodes.delete(messageId);
        messageVisibilityState.delete(messageId);
    };
}

function invalidateAllTranslations() {
    clearTranslationCaches();
    for (const [messageId, entry] of translatedMessageState) {
        safeUpdateMessage(entry.channelId, messageId, {
            content: entry.originalContent,
            [ORIGINAL_CONTENT_FIELD]: entry.originalContent,
            [TRANSLATED_CONTENT_FIELD]: entry.translatedContent
        } as any);
    }
    translatedMessageState.clear();
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

function getOriginalMessageContent(message: Message): string {
    const tracked = translatedMessageState.get(message.id);
    if (tracked) {
        if ((message.content ?? "") === tracked.translatedContent) {
            return tracked.originalContent;
        }

        if ((message.content ?? "") === tracked.originalContent) {
            return tracked.originalContent;
        }
    }

    const lingoMessage = message as LingoMessage;
    const original = lingoMessage[ORIGINAL_CONTENT_FIELD];
    const translated = lingoMessage[TRANSLATED_CONTENT_FIELD];

    if (typeof original === "string"
        && typeof translated === "string"
        && translated.length > 0
        && (message.content ?? "") === translated
    ) {
        return original;
    }

    return message.content ?? "";
}

function getMessageCacheKey(messageId: string, sourceContent: string, translatorConfigFingerprint = getTranslatorConfigFingerprint()): string {
    return `${messageId}:${sourceContent}:${translatorConfigFingerprint}`;
}

function shouldTranslateMessage(message: Message): boolean {
    const sourceContent = getOriginalMessageContent(message);
    if (!sourceContent.trim()) return false;
    if (!shouldTranslateContent(sourceContent)) return false;

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
        const maxConcurrentRequests = Math.max(1, settings.store.maxConcurrentRequests || 1);

        const run = () => {
            activeRequests++;

            task()
                .then(resolve, reject)
                .finally(() => {
                    activeRequests--;
                    requestQueue.shift()?.();
                });
        };

        if (activeRequests < maxConcurrentRequests) {
            run();
        } else {
            requestQueue.push(run);
        }
    });
}

function requestTranslation(messageId: string, sourceContent: string, translatorConfigFingerprint: string): Promise<TranslationState> {
    const key = getMessageCacheKey(messageId, sourceContent, translatorConfigFingerprint);

    const cached = translationCache.get(key);
    if (cached) return Promise.resolve(cached);

    const currentRequest = inFlightRequests.get(key);
    if (currentRequest) return currentRequest;

    const request = (async () => {
        const targetLanguage = normalizeTargetLanguage(settings.store.targetLanguage);

        const persistentHit = await tryGetPersistentTranslation(sourceContent, translatorConfigFingerprint);
        if (persistentHit) return persistentHit;

        const result = await scheduleTranslation(() => fetchTranslation(sourceContent, targetLanguage));
        rememberPersistentTranslation(sourceContent, translatorConfigFingerprint, result);
        return result;
    })()
        .then(result => {
            translationCache.set(key, result);
            pruneInMemoryTranslationCache();
            return result;
        })
        .catch(error => {
            const errorMessage = error instanceof Error ? error.message : "translation unavailable";
            const fallback: TranslationState = { status: "error", message: errorMessage };
            translationCache.set(key, fallback);
            pruneInMemoryTranslationCache();
            return fallback;
        })
        .finally(() => {
            inFlightRequests.delete(key);
        });

    inFlightRequests.set(key, request);
    return request;
}

function getMessageNode(messageId: string) {
    return document.getElementById(`message-content-${messageId}`) as HTMLElement | null;
}

function restoreOriginalMessage(message: Message, sourceContent: string) {
    const tracked = translatedMessageState.get(message.id);
    const lingoMessage = message as LingoMessage;
    const currentContent = message.content ?? "";
    const originalContent = tracked?.originalContent ?? sourceContent;
    const translatedContent =
        tracked?.translatedContent
            ?? (typeof lingoMessage[TRANSLATED_CONTENT_FIELD] === "string"
                ? lingoMessage[TRANSLATED_CONTENT_FIELD]
                : "");

    if (currentContent === originalContent && !pendingMessageMutations.has(message.id)) {
        return;
    }

    enqueueMessageMutation(message.id, {
        channelId: message.channel_id,
        content: originalContent,
        originalContent,
        translatedContent
    });
}

function applyTranslationToMessage(message: Message, sourceContent: string, translatedText: string) {
    const lingoMessage = message as LingoMessage;
    if ((message.content ?? "") === translatedText
        && lingoMessage[ORIGINAL_CONTENT_FIELD] === sourceContent
    ) {
        return;
    }

    translatedMessageState.set(message.id, {
        channelId: message.channel_id,
        originalContent: sourceContent,
        translatedContent: translatedText
    });

    enqueueMessageMutation(message.id, {
        channelId: message.channel_id,
        content: translatedText,
        originalContent: sourceContent,
        translatedContent: translatedText
    });
}

function replaceMessageWithTranslation(message: Message, sourceContent: string, translatedText: string) {
    if (isScrollActive) {
        // Never mutate message content while the user is actively scrolling.
        return;
    }

    if (!getMessageNode(message.id)) {
        return;
    }

    applyTranslationToMessage(message, sourceContent, translatedText);
}

function useMessageVisibility(messageId: string): boolean {
    const [isVisible, setVisible] = useState(!("IntersectionObserver" in window));

    useEffect(() => {
        if (!("IntersectionObserver" in window)) {
            setVisible(true);
            return;
        }

        const unsubscribe = subscribeToMessageVisibility(messageId, setVisible);
        let retryTimer: ReturnType<typeof setTimeout> | null = null;

        if (!tryObserveMessageVisibility(messageId)) {
            setVisible(false);
            retryTimer = setTimeout(() => {
                if (tryObserveMessageVisibility(messageId)) {
                    const observedState = messageVisibilityState.get(messageId);
                    if (typeof observedState === "boolean") {
                        setVisible(observedState);
                    }
                }
            }, 50);
        }

        return () => {
            if (retryTimer) {
                clearTimeout(retryTimer);
            }
            unsubscribe();
        };
    }, [messageId]);

    return isVisible;
}

function useScrollActivity(): boolean {
    const [scrolling, setScrolling] = useState(isScrollActive);

    useEffect(() => {
        return subscribeToScrollState(setScrolling);
    }, []);

    return scrolling;
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
    const sourceContent = getOriginalMessageContent(message);
    const [showOriginal, setShowOriginal] = useState(false);
    const [translation, setTranslation] = useState<TranslationState>(
        () => translationCache.get(getMessageCacheKey(message.id, sourceContent, translatorConfigFingerprint)) ?? { status: "idle" }
    );
    const shouldTranslate = shouldTranslateMessage(message);
    const isVisible = useMessageVisibility(message.id);
    const isScrolling = useScrollActivity();
    const [visibilitySettled, setVisibilitySettled] = useState(!onlyTranslateVisible);

    useEffect(() => {
        if (!onlyTranslateVisible) {
            setVisibilitySettled(true);
            return;
        }

        if (!isVisible) {
            setVisibilitySettled(false);
            return;
        }

        setVisibilitySettled(false);
        const timer = setTimeout(() => {
            setVisibilitySettled(true);
        }, 120);

        return () => {
            clearTimeout(timer);
        };
    }, [message.id, onlyTranslateVisible, isVisible]);

    useEffect(() => {
        setTranslation(translationCache.get(getMessageCacheKey(message.id, sourceContent, translatorConfigFingerprint)) ?? { status: "idle" });
        setShowOriginal(false);
    }, [message.id, sourceContent, translatorConfigFingerprint]);

    useEffect(() => {
        if (!shouldTranslate || (onlyTranslateVisible && (!isVisible || !visibilitySettled))) return;

        const key = getMessageCacheKey(message.id, sourceContent, translatorConfigFingerprint);
        const cached = translationCache.get(key);
        if (cached) {
            setTranslation(cached);
            return;
        }

        setTranslation({ status: "pending" });
        let cancelled = false;

        requestTranslation(message.id, sourceContent, translatorConfigFingerprint).then(result => {
            if (!cancelled) setTranslation(result);
        });

        return () => {
            cancelled = true;
        };
    }, [message.id, sourceContent, shouldTranslate, isVisible, visibilitySettled, onlyTranslateVisible, translatorConfigFingerprint]);

    useEffect(() => {
        if (!shouldTranslate) {
            restoreOriginalMessage(message, sourceContent);
            return;
        }

        // Manual toggle must always be responsive, even while scroll tracking is active.
        if (showOriginal) {
            restoreOriginalMessage(message, sourceContent);
            return;
        }

        if (onlyTranslateVisible && (!isVisible || !visibilitySettled)) {
            return;
        }

        if (isScrolling) {
            return;
        }

        if (translation.status === "ready" && !showOriginal) {
            replaceMessageWithTranslation(message, sourceContent, translation.text);
            return;
        }
    }, [message, sourceContent, shouldTranslate, showOriginal, translation, onlyTranslateVisible, isVisible, visibilitySettled, isScrolling]);

    useEffect(() => {
        if (translation.status === "error") {
            setShowOriginal(true);
        }
    }, [translation, message.id]);

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
    dependencies: ["MessageAccessoriesAPI", "MessageUpdaterAPI"],

    start() {
        windowScrollHandler = () => {
            markScrollActivity();
        };
        windowKeydownHandler = event => {
            if (SCROLLING_KEYS.has(event.key)) {
                markScrollActivity();
            }
        };
        windowTouchMoveHandler = () => {
            markScrollActivity();
        };
        window.addEventListener("wheel", windowScrollHandler, { passive: true });
        window.addEventListener("keydown", windowKeydownHandler, { passive: true });
        window.addEventListener("touchmove", windowTouchMoveHandler, { passive: true });
        addMessageAccessory(PLUGIN_ID, ({ message }) => <LingoAccessory message={message} />);
        void ensurePersistentMemoryLoaded();
    },

    stop() {
        if (windowScrollHandler) {
            window.removeEventListener("wheel", windowScrollHandler as EventListener);
            windowScrollHandler = null;
        }
        if (windowKeydownHandler) {
            window.removeEventListener("keydown", windowKeydownHandler);
            windowKeydownHandler = null;
        }
        if (windowTouchMoveHandler) {
            window.removeEventListener("touchmove", windowTouchMoveHandler);
            windowTouchMoveHandler = null;
        }
        if (scrollIdleTimer) {
            clearTimeout(scrollIdleTimer);
            scrollIdleTimer = null;
        }
        setScrollActive(false);
        removeMessageAccessory(PLUGIN_ID);
        if (persistMemoryTimer) {
            clearTimeout(persistMemoryTimer);
            persistMemoryTimer = null;
        }
        sharedVisibilityObserver?.disconnect();
        sharedVisibilityObserver = null;
        visibilitySubscribers.clear();
        observedMessageNodes.clear();
        messageVisibilityState.clear();
        void persistMemoryNow();
        invalidateAllTranslations();
    }
});
