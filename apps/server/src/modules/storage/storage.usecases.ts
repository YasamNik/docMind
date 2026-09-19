import { basename } from "node:path";
import { createError, isAppError } from "../../shared/errors/errors.js";
import type { SettingsService } from "../settings/settings.usecases.js";
import { storageDriverRegistry, type StorageDriverId } from "./storage.registry.js";
import { buildOAuthRedirectUri, signOAuthState, verifyOAuthState } from "./storage.models.js";
import type { StorageDriverDefinition } from "./storage.types.js";

function oauthDefinitionOrThrow(driverId: string) {
  const definition = storageDriverRegistry[driverId as StorageDriverId];
  if (!definition?.oauth) {
    throw createError({
      code: "storage.oauth_not_supported",
      message: `"${definition?.label ?? driverId}" does not connect through an account`,
      status: 400,
    });
  }
  return { definition, oauth: definition.oauth };
}

export function buildStorageKey({
  userId,
  documentId,
  filename,
  uploadedAt,
}: {
  userId: string;
  documentId: string;
  filename: string;
  uploadedAt: Date;
}) {
  const base = basename(filename.replace(/\\/g, "/"));
  const safe = base.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "").slice(0, 200) || "file";
  const yyyy = uploadedAt.getUTCFullYear();
  const mm = String(uploadedAt.getUTCMonth() + 1).padStart(2, "0");
  return `${userId}/${yyyy}/${mm}/${documentId}/${safe}`;
}

export function createStorageService({
  settingsService,
  countDocuments,
}: {
  settingsService: SettingsService;
  // Storage is a foundational module; it does not depend on the documents repository.
  // The caller supplies this narrow count function from whatever repository it already
  // has, instead of storage building its own copy of it.
  countDocuments: (args: { userId: string; storageDriver: string }) => Promise<number>;
}) {
  // A driver is ready when nothing it cannot invent is missing. Settings that carry a
  // default (prefix, path style) are never the reason a driver is unusable, so only the
  // ones without one are checked.
  async function isConfigured({ definition, userId }: { definition: StorageDriverDefinition; userId: string }) {
    const required = definition.settings.filter((setting) => setting.default === undefined && !setting.internal);
    for (const setting of required) {
      const value = await settingsService.get<unknown>(userId, setting.key);
      if (value === undefined || value === null || value === "") return false;
    }
    return true;
  }

  return {
    async getDriver(userId: string, driverId: string) {
      const definition = storageDriverRegistry[driverId as StorageDriverId];
      if (!definition) {
        throw createError({ code: "storage.unknown_driver", message: `Unknown storage driver "${driverId}"`, status: 400 });
      }
      return definition.create({ settings: settingsService, userId });
    },
    async getActiveDriverId(userId: string) {
      return (await settingsService.get<StorageDriverId>(userId, "storage.activeDriver")) ?? "local";
    },
    async getActiveDriver(userId: string) {
      return this.getDriver(userId, await this.getActiveDriverId(userId));
    },

    // Resolved from the definition, never the driver instance: a document must keep
    // pointing at its original file even when the driver that holds it cannot currently
    // be built, for example right after its credentials were cleared or its account
    // disconnected.
    async describeLocation(userId: string, driverId: string, key: string) {
      const definition = storageDriverRegistry[driverId as StorageDriverId];
      if (!definition) {
        throw createError({ code: "storage.unknown_driver", message: `Unknown storage driver "${driverId}"`, status: 400 });
      }
      return definition.describeLocation({ settings: settingsService, userId, key });
    },

    // One call renders the whole picker: what exists, what is ready, what it holds, and
    // the guide that explains the fields. redirectUri and accountEmail are only set for
    // a driver with an oauth hook, which is also how the settings page tells an oauth
    // driver apart from one configured by hand.
    async listDriverSummaries(userId: string, args?: { origin?: string }) {
      const active = await this.getActiveDriverId(userId);
      return Promise.all(
        Object.values(storageDriverRegistry).map(async (definition) => ({
          id: definition.id,
          label: definition.label,
          guide: definition.guide,
          configured: await isConfigured({ definition, userId }),
          documentCount: await countDocuments({ userId, storageDriver: definition.id }),
          active: definition.id === active,
          redirectUri:
            definition.oauth && args?.origin ? buildOAuthRedirectUri({ origin: args.origin, driverId: definition.id }) : undefined,
          accountEmail: definition.oauth ? await settingsService.get<string>(userId, definition.oauth.keys.accountEmail) : undefined,
        })),
      );
    },

    async testDriver({ userId, driverId }: { userId: string; driverId: string }) {
      return (await this.getDriver(userId, driverId)).healthCheck();
    },

    // The client id and secret already saved for an oauth driver's own connection, for
    // a caller outside storage that wants to reuse the same Google app rather than
    // asking the user to register a second one. Returns undefined rather than throwing
    // when nothing is saved yet, since "nothing to reuse" is an ordinary outcome for a
    // caller deciding what to fall back to, not a storage error.
    async readOAuthApp({ userId, driverId }: { userId: string; driverId: string }): Promise<{ clientId: string; clientSecret: string } | undefined> {
      const { oauth } = oauthDefinitionOrThrow(driverId);
      const clientId = await settingsService.get<string>(userId, oauth.keys.clientId);
      const clientSecret = await settingsService.get<string>(userId, oauth.keys.clientSecret);
      if (!clientId || !clientSecret) return undefined;
      return { clientId, clientSecret };
    },

    // Sends the browser to the provider. The state carries the user's identity because
    // the callback that follows arrives with no session of its own.
    async buildAuthorizeUrl({ userId, driverId, origin, secretHex }: { userId: string; driverId: string; origin: string; secretHex: string }) {
      const { definition, oauth } = oauthDefinitionOrThrow(driverId);
      const clientId = await settingsService.get<string>(userId, oauth.keys.clientId);
      if (!clientId) {
        throw createError({
          code: "storage.driver_not_configured",
          message: `Set the client id for "${definition.label}" before connecting`,
          status: 400,
        });
      }
      const redirectUri = buildOAuthRedirectUri({ origin, driverId });
      const state = signOAuthState({ userId, driverId, secretHex });
      return oauth.authorizeUrl({ clientId, redirectUri, state });
    },

    // Verifies the signed state before touching anything else, since it is the only
    // thing that says which user this browser redirect belongs to. Rejects a state that
    // was issued for a different driver than the one in the path.
    async completeOAuthConnection({
      driverId,
      code,
      state,
      origin,
      secretHex,
    }: {
      driverId: string;
      code: string;
      state: string;
      origin: string;
      secretHex: string;
    }) {
      const verified = verifyOAuthState({ state, secretHex });
      if (verified.driverId !== driverId) {
        throw createError({
          code: "storage.invalid_state",
          message: "Oauth state was issued for a different storage driver",
          status: 400,
        });
      }

      const { oauth } = oauthDefinitionOrThrow(driverId);
      const userId = verified.userId;
      const clientId = await settingsService.get<string>(userId, oauth.keys.clientId);
      const clientSecret = await settingsService.get<string>(userId, oauth.keys.clientSecret);
      if (!clientId || !clientSecret) {
        throw createError({
          code: "storage.driver_not_configured",
          message: `Set the client id and secret for "${driverId}" before connecting`,
          status: 400,
        });
      }

      const redirectUri = buildOAuthRedirectUri({ origin, driverId });
      // A driver's exchange is expected to sanitize its own provider's errors, but this
      // is the generic entry point every current and future oauth driver runs through,
      // so nothing that is not already a clean AppError is allowed past it either.
      let refreshToken: string;
      let accountEmail: string;
      try {
        ({ refreshToken, accountEmail } = await oauth.exchange({ code, clientId, clientSecret, redirectUri }));
      } catch (error) {
        if (isAppError(error)) throw error;
        throw createError({
          code: "storage.oauth_exchange_failed",
          message: `Could not complete the connection for "${driverId}"`,
          status: 502,
        });
      }
      await settingsService.set(userId, {
        [oauth.keys.refreshToken]: refreshToken,
        [oauth.keys.accountEmail]: accountEmail,
      });

      return { driverId };
    },
  };
}

export type StorageService = ReturnType<typeof createStorageService>;
