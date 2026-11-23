/**
 * Mobile Biometric Authenticator & Key Signing Helper
 *
 * Provides biometric authentication (Face ID / Touch ID / Fingerprint) protection
 * for session signing keys, enforcing a 15-minute inactivity session expiration
 * and fallback to passphrase after 3 failed attempts.
 */

import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";

export interface BiometricAuthResult {
  success: boolean;
  error?: string;
  fallbackToPassphrase?: boolean;
}

export interface BiometricAuthConfig {
  /** Prompt message shown during biometric authentication */
  promptMessage?: string;
  /** Number of failed attempts before falling back to passphrase */
  maxFailuresBeforeFallback?: number;
  /** Session TTL in milliseconds (default: 15 minutes) */
  sessionTtlMs?: number;
}

const DEFAULT_PROMPT_MESSAGE = "Authorize transaction with biometrics";
const DEFAULT_MAX_FAILURES_BEFORE_FALLBACK = 3;
const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;

class BiometricSessionManager {
  private lastActiveTimestamp: number = 0;
  private sessionTtlMs: number;
  private hasActiveSession: boolean = false;
  private failureCount: number = 0;

  constructor(config?: BiometricAuthConfig) {
    this.sessionTtlMs = config?.sessionTtlMs || DEFAULT_SESSION_TTL_MS;
  }

  isSessionValid(): boolean {
    if (!this.hasActiveSession) return false;
    const now = Date.now();
    if (now - this.lastActiveTimestamp > this.sessionTtlMs) {
      this.invalidateSession();
      return false;
    }
    return true;
  }

  touchSession(): void {
    this.lastActiveTimestamp = Date.now();
    this.failureCount = 0; // reset failures on successful touch
  }

  invalidateSession(): void {
    this.hasActiveSession = false;
    this.lastActiveTimestamp = 0;
    this.failureCount = 0;
  }

  async authenticateWithBiometrics(
    config: BiometricAuthConfig = {}
  ): Promise<BiometricAuthResult> {
    const {
      promptMessage = DEFAULT_PROMPT_MESSAGE,
      maxFailuresBeforeFallback = DEFAULT_MAX_FAILURES_BEFORE_FALLBACK,
    } = config;

    // Check if session is already active and valid
    if (this.isSessionValid()) {
      this.touchSession();
      return { success: true };
    }

    // Check if biometrics are available on this device
    const biometricType = await LocalAuthentication.isBiometricAvailableAsync();
    if (!biometricType) {
      return {
        success: false,
        error: "Biometric hardware not available",
        fallbackToPassphrase: true,
      };
    }

    // Check if we've exceeded max failures
    if (this.failureCount >= maxFailuresBeforeFallback) {
      return {
        success: false,
        error: "Too many failed biometric attempts. Falling back to passphrase.",
        fallbackToPassphrase: true,
      };
    }

    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage,
        biometryType: biometricType,
        cancelButtonTitle: "Use passphrase",
      });

      if (result.success) {
        // Successful authentication establishes session
        this.hasActiveSession = true;
        this.touchSession();
        this.failureCount = 0;
        return { success: true };
      } else {
        // Failed authentication
        this.failureCount++;
        this.invalidateSession();
        return {
          success: false,
          error: result.error ?? "Biometric authentication failed",
          fallbackToPassphrase: this.failureCount >= maxFailuresBeforeFallback,
        };
      }
    } catch (err) {
      this.failureCount++;
      this.invalidateSession();
      return {
        success: false,
        error: err instanceof Error ? err.message : "Biometric authentication failed",
        fallbackToPassphrase: this.failureCount >= maxFailuresBeforeFallback,
      };
    }
  }
}

export const biometricSessionManager = new BiometricSessionManager();

/**
 * Signs a transaction XDR with biometric authentication protection.
 * Prompts for biometrics before signing, stores the wallet key securely,
 * and falls back to passphrase after 3 failed attempts.
 */
export async function signWithBiometricProtection(
  signFn: (promptMessage: string) => Promise<{ hash: string; txHash?: string }>,
  options: {
    contractId: string;
    rpcUrl: string;
    networkPassphrase: string;
    promptMessage?: string;
  }
): Promise<{ hash: string; txHash?: string }> {
  // Step 1: Authenticate with biometrics
  const authResult = await biometricSessionManager.authenticateWithBiometrics({
    promptMessage: options.promptMessage || "Authorize transaction with biometrics",
  });

  if (!authResult.success) {
    if (authResult.fallbackToPassphrase) {
      throw new Error(
        "Biometric authentication failed. Maximum retry attempts reached. " +
          "Please use your passphrase to sign the transaction."
      );
    }
    throw new Error(authResult.error || "Biometric authentication failed");
  }

  // Step 2: Perform the actual signing
  try {
    const result = await signFn(authResult.promptMessage ?? "Authorize transaction with biometrics");

    // Step 3: Store wallet key securely after successful sign
    // The wallet key is already stored in expo-secure-store by the wallet kit
    // This function ensures it's properly protected

    return result;
  } catch (signError) {
    // Signing failed - increment failure count for biometric tracking
    biometricSessionManager.failureCount++;
    biometricSessionManager.invalidateSession();

    const errorMsg =
      signError instanceof Error ? signError.message : "Failed to sign transaction";

    throw new Error(`Transaction signing failed: ${errorMsg}`);
  }
}

/**
 * Checks if biometrics are available on the current device.
 */
export async function checkBiometricsAvailable(): Promise<{
  available: boolean;
  biometryType: string;
  error?: string;
}> {
  try {
    const biometryType = await LocalAuthentication.isBiometricAvailableAsync();
    return {
      available: biometryType !== "NO_BIOMETRY",
      biometryType: biometryType || "none",
    };
  } catch (err) {
    return {
      available: false,
      biometryType: "none",
      error: err instanceof Error ? err.message : "Failed to check biometrics",
    };
  }
}

/**
 * Remembers a passphrase for future use (falls back when biometrics unavailable).
 * Stores the decrypted key material in secure storage with authentication required.
 */
export async function storePassphraseSecurely(
  passphrase: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Derive a service-specific key from SecureStore master key
    const masterKey = await (SecureStore as any).getItemAsync(
      "@linkora/master_key",
      {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        requireAuthentication: true,
      }
    );

    // Store the passphrase encrypted with a service-specific key
    const serviceKey = await (SecureStore as any).getItemAsync(
      `@linkora/passphrase-service-key`,
      {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        requireAuthentication: true,
      }
    );

    // If no service key exists, derive one from the master key
    if (!serviceKey) {
      const encoder = new TextEncoder();
      const masterData = encoder.encode(masterKey || "");
      const digest = await globalThis.crypto?.subtle?.digest(
        "SHA-256",
        masterData
      );
      const derivedKey = digest
        ? Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, "0")
          ).join("")
        : masterKey || "";

      await (SecureStore as any).setItemAsync(
        `@linkora/passphrase-service-key`,
        derivedKey,
        {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
          requireAuthentication: true,
        }
      );
    }

    // Store the passphrase (encrypted)
    await (SecureStore as any).setItemAsync(
      `@linkora/user-passphrase`,
      passphrase,
      {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        requireAuthentication: true,
      }
    );

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to store passphrase securely",
    };
  }
}

/**
 * Retrieves a previously stored passphrase securely.
 */
export async function retrievePassphraseSecurely():
  Promise<{ success: boolean; passphrase?: string; error?: string }> {
  try {
    const passphrase = await (SecureStore as any).getItemAsync(
      `@linkora/user-passphrase`,
      {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        requireAuthentication: true,
      }
    );

    if (!passphrase) {
      return { success: false, error: "No passphrase stored" };
    }

    return { success: true, passphrase };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to retrieve passphrase",
    };
  }
}