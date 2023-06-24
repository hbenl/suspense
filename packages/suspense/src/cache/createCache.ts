import { isDevelopment } from "#is-development";
import { unstable_getCacheForType as getCacheForTypeMutable } from "react";
import { STATUS_NOT_FOUND, STATUS_PENDING } from "../constants";
import {
  Cache,
  CacheLoadOptions,
  CacheMap,
  PendingRecord,
  Record,
  Status,
  StatusCallback,
  UnsubscribeCallback,
} from "../types";
import {
  createPendingRecord,
  createResolvedRecord,
  updateRecordToRejected,
  updateRecordToResolved,
} from "../utils/Record";
import { assertPendingRecord } from "../utils/assertRecordStatus";
import { createDeferred } from "../utils/createDeferred";
import { log } from "../utils/debugging";
import { defaultGetCache } from "../utils/defaultGetCache";
import { defaultGetKey } from "../utils/defaultGetKey";
import { isPromiseLike } from "../utils/isPromiseLike";
import {
  isPendingRecord,
  isRejectedRecord,
  isResolvedRecord,
} from "../utils/isRecordStatus";

console.log("[createCache] isDevelopment:", isDevelopment);
console.log("[createCache] NODE_ENV:", process.env.NODE_ENV);
export type InternalCache<Params extends Array<any>, Value> = Cache<
  Params,
  Value
> & {
  __createPendingMutationRecordMap: () => CacheMap<string, Record<Value>>;
  __getKey: (params: Params) => string;
  __getOrCreateRecord: (...params: Params) => Record<Value>;
  __isImmutable: () => boolean;
  __mutationAbortControllerMap: Map<string, AbortController>;
  __notifySubscribers: (params: Params) => void;
  __recordMap: CacheMap<string, Record<Value>>;
};

export type CreateCacheOptions<Params extends Array<any>, Value> = {
  config?: {
    getCache?: (
      onEviction: (key: string) => void
    ) => CacheMap<string, Record<Value>>;
    immutable?: boolean;
  };
  debugLabel?: string;
  enableDebugLogging?: boolean;
  getKey?: (params: Params) => string;
  load: (
    params: Params,
    loadOptions: CacheLoadOptions
  ) => PromiseLike<Value> | Value;
};

export function createCache<Params extends Array<any>, Value>(
  options: CreateCacheOptions<Params, Value>
): Cache<Params, Value> {
  let {
    config = {},
    debugLabel,
    enableDebugLogging,
    getKey = defaultGetKey,
    load,
  } = options;
  const { getCache = defaultGetCache, immutable = false } = config;

  if (isDevelopment) {
    let didLogWarning = false;
    let decoratedGetKey = getKey;

    getKey = (params: Params) => {
      const key = decoratedGetKey(params);

      if (!didLogWarning) {
        if (key.includes("[object Object]")) {
          didLogWarning = true;
          console.warn(
            `Warning: createCache() key "${key}" contains a stringified object and may not be unique`
          );
        }
      }

      return key;
    };
  }

  const debugLog = (message: string, params?: Params, ...args: any[]) => {
    const cacheKey = params ? `"${getKey(params)}"` : "";
    const prefix = debugLabel ? `createCache[${debugLabel}]` : "createCache";

    log(enableDebugLogging, [
      `%c${prefix}`,
      "font-weight: bold; color: yellow;",
      message,
      cacheKey,
      ...args,
    ]);
  };

  debugLog("Creating cache ...");

  // This map enables selective mutations to be scheduled with React
  // (one record can be invalidated without affecting others)
  // Reads will query the map created by createRecordMap first,
  // and fall back to this map if no match is found
  const recordMap = getCache(onExternalCacheEviction);

  // Stores status of in-progress mutation
  // If no entry is present here, the Record map will be used instead
  // Storing this information separately enables status to be updated during mutation
  // without modifying the actual record (which may trigger an unintentional update/fallback)
  const mutationAbortControllerMap = new Map<string, AbortController>();

  // Stores a set of callbacks (by key) for status subscribers.
  const subscriberMap = new Map<string, Set<StatusCallback>>();

  // Immutable caches should read from backing cache directly.
  // Only mutable caches should use React-managed cache
  // in order to reduce re-renders when caches are refreshed for mutations.
  const getCacheForType = immutable ? () => recordMap : getCacheForTypeMutable;

  function abort(...params: Params): boolean {
    const cacheKey = getKey(params);
    const pendingMutationRecordMap = getCacheForType(
      createPendingMutationRecordMap
    );

    // In-progress mutations aren't guaranteed to be in the recordMap.
    // So we check the mutationAbortControllerMap to infer this.
    const abortController = mutationAbortControllerMap.get(cacheKey);
    if (abortController) {
      debugLog("abort()", params);

      abortController.abort();

      notifySubscribers(params);

      return true;
    } else {
      const record =
        pendingMutationRecordMap.get(cacheKey) ?? recordMap.get(cacheKey);
      if (record && isPendingRecord(record)) {
        debugLog("abort()", params);

        pendingMutationRecordMap.delete(cacheKey);

        // Only delete the main cache if it's the same record/request
        // Aborting a mutation should not affect the main cache
        if (recordMap.get(cacheKey) === record) {
          recordMap.delete(cacheKey);
        }

        record.data.abortController.abort();

        notifySubscribers(params);

        return true;
      }
    }

    return false;
  }

  function cache(value: Value, ...params: Params): void {
    const cacheKey = getKey(params);
    const pendingMutationRecordMap = getCacheForType(
      createPendingMutationRecordMap
    );

    let record: Record<Value> | undefined = getRecord(...params);
    if (record != null) {
      if (isPendingRecord(record)) {
        debugLog("cache()", params, "Update pending record to:", value);

        const { abortController, deferred } = record.data;

        abortController.abort();

        updateRecordToResolved(record, value);

        // Don't leave any pending request hanging
        deferred.resolve(value);

        return;
      }
    }

    debugLog("cache()", params, "Create new resolved record with:", value);

    record = createResolvedRecord<Value>(value);

    recordMap.set(cacheKey, record);
    pendingMutationRecordMap.set(cacheKey, record);
  }

  function createPendingMutationRecordMap(): CacheMap<string, Record<Value>> {
    return getCache((key) => {
      // We don't really need to do anything here
      // This map will almost always be a subset of the recordMap
      // but we also don't want it to bypass the getCache() eviction logic (if any)
      // Leave a debug log here in case we need to revisit this
      debugLog(`getCache() ${key}`);
    });
  }

  function evict(...params: Params): boolean {
    const cacheKey = getKey(params);
    const pendingMutationRecordMap = getCacheForType(
      createPendingMutationRecordMap
    );

    debugLog(`evict()`, params);

    const didDelete = recordMap.delete(cacheKey);
    pendingMutationRecordMap.delete(cacheKey);

    notifySubscribers(params);

    return didDelete;
  }

  function evictAll(): void {
    const pendingMutationRecordMap = getCacheForType(
      createPendingMutationRecordMap
    );

    debugLog(`evictAll()`, undefined);

    recordMap.clear();
    pendingMutationRecordMap.clear();

    subscriberMap.forEach((set) => {
      set.forEach((callback) => {
        callback(STATUS_NOT_FOUND);
      });
    });
    subscriberMap.clear();
  }

  function getRecord(...params: Params): Record<Value> | undefined {
    const cacheKey = getKey(params);
    const pendingMutationRecordMap = getCacheForType(
      createPendingMutationRecordMap
    );

    return pendingMutationRecordMap.get(cacheKey) ?? recordMap.get(cacheKey);
  }

  function getOrCreateRecord(...params: Params): Record<Value> {
    const cacheKey = getKey(params);
    const pendingMutationRecordMap = getCacheForType(
      createPendingMutationRecordMap
    );

    let record = getRecord(...params);
    if (record == null) {
      debugLog(
        "getOrCreateRecord(): record not found. creating record...",
        params
      );
      const abortController = new AbortController();
      const deferred = createDeferred<Value>(
        debugLabel ? `${debugLabel} ${cacheKey}` : cacheKey
      );

      record = createPendingRecord<Value>(deferred, abortController);
      recordMap.set(cacheKey, record);
      pendingMutationRecordMap.set(cacheKey, record);

      notifySubscribers(params);

      processPendingRecord(abortController.signal, record, ...params);
    }
    debugLog(
      "getOrCreateRecord(): record found. returning record",
      params,
      record
    );

    return record;
  }

  function getStatus(...params: Params): Status {
    const cacheKey = getKey(params);

    // Check for pending mutations first
    if (mutationAbortControllerMap.has(cacheKey)) {
      return STATUS_PENDING;
    }

    // Else fall back to Record status
    const record = recordMap.get(cacheKey);

    if (!record) {
      return STATUS_NOT_FOUND;
    } else if (isResolvedRecord(record)) {
      return record.data.status;
    }

    return record.data.status;
  }

  function getValue(...params: Params): Value {
    const cacheKey = getKey(params);
    const record = recordMap.get(cacheKey);

    if (record == null) {
      throw Error("No record found");
    } else if (isRejectedRecord(record)) {
      throw record.data.error;
    } else if (isResolvedRecord(record)) {
      return record.data.value;
    } else {
      throw Error(`Record found with status "${record.data.status}"`);
    }
  }

  function getValueIfCached(...params: Params): Value | undefined {
    const cacheKey = getKey(params);
    const record = recordMap.get(cacheKey);
    if (record && isResolvedRecord(record)) {
      return record.data.value;
    }
  }

  function onExternalCacheEviction(key: string): void {
    debugLog(`onExternalCacheEviction(${key})`);

    const set = subscriberMap.get(key);
    if (set) {
      set.forEach((callback) => {
        callback(STATUS_NOT_FOUND);
      });
    }
  }

  function prefetch(...params: Params): void {
    debugLog(`prefetch()`, params);

    const promiseOrValue = readAsync(...params);
    if (isPromiseLike(promiseOrValue)) {
      promiseOrValue.then(
        () => {},
        (error) => {
          // Don't let readAsync throw an uncaught error.
        }
      );
    }
  }

  function readAsync(...params: Params): PromiseLike<Value> | Value {
    const record = getOrCreateRecord(...params);
    if (isPendingRecord(record)) {
      return record.data.deferred.promise;
    }
    if (isResolvedRecord(record)) {
      return record.data.value;
    }
    throw record.data.error;
  }

  function read(...params: Params): Value {
    const record = getOrCreateRecord(...params);
    if (isPendingRecord(record)) {
      throw record.data.deferred.promise;
    } else if (isResolvedRecord(record)) {
      return record.data.value;
    } else {
      throw record.data.error;
    }
  }

  function notifySubscribers(params: Params): void {
    const cacheKey = getKey(params);
    const set = subscriberMap.get(cacheKey);
    if (set) {
      const status = getStatus(...params);
      set.forEach((callback) => {
        callback(status);
      });
    }
  }

  async function processPendingRecord(
    abortSignal: AbortSignal,
    record: PendingRecord<Value>,
    ...params: Params
  ) {
    assertPendingRecord(record);

    const { abortController, deferred } = record.data;

    try {
      const valueOrPromiseLike = load(params, abortController);
      const value = isPromiseLike(valueOrPromiseLike)
        ? await valueOrPromiseLike
        : valueOrPromiseLike;

      if (!abortSignal.aborted) {
        debugLog(
          "processPendingRecord(): resolved",
          params,
          "resolved value: ",
          value
        );
        updateRecordToResolved(record, value);

        deferred.resolve(value);
      }
    } catch (error) {
      if (!abortSignal.aborted) {
        debugLog("processPendingRecord(): rejected", params, error);
        updateRecordToRejected(record, error);

        deferred.reject(error);
      }
    } finally {
      if (!abortSignal.aborted) {
        notifySubscribers(params);
      }
    }
  }

  function subscribeToStatus(
    callback: StatusCallback,
    ...params: Params
  ): UnsubscribeCallback {
    const cacheKey = getKey(params);
    let set = subscriberMap.get(cacheKey);
    if (set) {
      set.add(callback);
    } else {
      set = new Set([callback]);
      subscriberMap.set(cacheKey, set);
    }

    try {
      const status = getStatus(...params);

      callback(status);
    } finally {
      return () => {
        set!.delete(callback);
        if (set!.size === 0) {
          subscriberMap.delete(cacheKey);
        }
      };
    }
  }

  const value: InternalCache<Params, Value> = {
    // Internal API (used by useCacheMutation)
    __createPendingMutationRecordMap: createPendingMutationRecordMap,
    __getKey: getKey,
    __getOrCreateRecord: getOrCreateRecord,
    __isImmutable: () => immutable,
    __mutationAbortControllerMap: mutationAbortControllerMap,
    __notifySubscribers: notifySubscribers,
    __recordMap: recordMap,

    // Public API
    abort,
    cache,
    evict,
    evictAll,
    getStatus,
    getValue,
    getValueIfCached,
    readAsync,
    read,
    prefetch,
    subscribeToStatus,
  };

  return value;
}
