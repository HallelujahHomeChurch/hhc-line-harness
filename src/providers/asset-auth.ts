import {
  ManagedIdentityCredential,
  type TokenCredential,
} from "@azure/identity";
import { DependencyError } from "./http.ts";

export type AssetCredential =
  string | ((signal: AbortSignal) => Promise<string>);
const validToken = (token: string) =>
  typeof token === "string" && /^[A-Za-z0-9._~-]{1,8192}$/.test(token);

export function assetHeaders(credential: AssetCredential) {
  if (typeof credential === "string" && !validToken(credential))
    throw new Error("invalid_asset_credential");
  return async (signal: AbortSignal): Promise<Record<string, string>> => {
    const token =
      typeof credential === "string" ? credential : await credential(signal);
    if (!validToken(token)) throw new DependencyError();
    return { "X-HHC-Workload-Authorization": `Bearer ${token}` };
  };
}

export function managedAssetToken(
  clientId: string,
  audience: string,
  credential?: TokenCredential,
): (signal: AbortSignal) => Promise<string> {
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  if (
    !new RegExp(`^${uuid}$`).test(clientId) ||
    !new RegExp(`^api://${uuid}$`).test(audience)
  )
    throw new Error("invalid_asset_identity");
  const identity = credential ?? new ManagedIdentityCredential({ clientId });
  return async (signal) => {
    let onAbort = () => {};
    try {
      signal.throwIfAborted();
      const interrupted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new DependencyError());
        signal.addEventListener("abort", onAbort, { once: true });
      });
      // The managed identity SDK does not cancel every underlying token transport.
      const result = await Promise.race([
        identity.getToken(audience + "/.default", { abortSignal: signal }),
        interrupted,
      ]);
      signal.throwIfAborted();
      if (
        !result ||
        !validToken(result.token) ||
        !Number.isFinite(result.expiresOnTimestamp) ||
        result.expiresOnTimestamp <= Date.now() + 30000
      )
        throw new Error();
      return result.token;
    } catch {
      throw new DependencyError();
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };
}
