import { useCallback } from "react";
import { useToast } from "../context/ToastContext";
import { useNetworkContext } from "../context/NetworkContext";
import { buildTxXdr } from "../utils/txDescriptors";
import {
  biometricSessionManager,
  checkBiometricsAvailable,
} from "../utils/biometric-signer";
import { notification } from "../utils/haptics";

// ---------------------------------------------------------------------------
// Soroban RPC helpers
// ---------------------------------------------------------------------------

interface SendTransactionResponse {
  hash: string;
  status: "PENDING" | "DUPLICATE" | "TRY_AGAIN_LATER" | "ERROR";
  errorResult?: unknown;
}

interface GetTransactionResponse {
  status: "SUCCESS" | "FAILED" | "NOT_FOUND";
  resultXdr?: string;
  resultMetaXdr?: string;
  envelopeXdr?: string;
  createdAt?: number;
}

async function rpcRequest<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  timeoutMs: number = 30_000
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`RPC HTTP error ${response.status}: ${response.statusText}`);
    }

    const json = (await response.json()) as { result?: T; error?: { message: string } };

    if (json.error) {
      throw new Error(`RPC error: ${json.error.message}`);
    }

    if (json.result === undefined) {
      throw new Error("RPC returned no result");
    }

    return json.result;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function sendTransaction(
  rpcUrl: string,
  signedXdr: string
): Promise<SendTransactionResponse> {
  return rpcRequest<SendTransactionResponse>(rpcUrl, "sendTransaction", [{ transaction: signedXdr }]);
}

async function pollTransaction(
  rpcUrl: string,
  hash: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<GetTransactionResponse> {
  const { intervalMs = 1_000, timeoutMs = 30_000 } = opts;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await rpcRequest<GetTransactionResponse>(rpcUrl, "getTransaction", [{ hash }]);

    if (result.status === "SUCCESS") return result;
    if (result.status === "FAILED") {
      throw new Error(`Transaction failed on-chain (hash: ${hash})`);
    }

    // NOT_FOUND — still pending, wait and try again
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Transaction confirmation timed out (hash: ${hash})`);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSubmitTx() {
  const { showPending, showSuccess, showError } = useToast();
  const { rpcUrl, contractId, network } = useNetworkContext();

  const submitTx = useCallback(
    async (txDescriptor: string): Promise<string> => {
      showPending();

      try {
        // Obtain the wallet adapter that was injected into the global by WalletContext
        const walletKit = (globalThis as { __LINKORA_WALLET_KIT__?: {
          signTransaction?: (payload: { txXdr: string }) => Promise<{
            signedTxXdr?: string;
            signedXdr?: string;
            signed?: string;
          }>;
          signAndSubmitTransaction?: (payload: {
            txXdr: string;
            rpcUrl?: string;
          }) => Promise<{ hash?: string; txHash?: string }>;
        } }).__LINKORA_WALLET_KIT__;

        if (!walletKit) {
          throw new Error("No wallet connected. Please connect your wallet first.");
        }

        // ------------------------------------------------------------------
        // Descriptor → real, simulated XDR
        // ------------------------------------------------------------------

        // Throws for an unknown method or a malformed descriptor, so a signing
        // path can never be handed something that is not a real transaction.
        const txXdr = await buildTxXdr(txDescriptor, {
          contractId,
          rpcUrl,
          network: network.id,
        });

        // ------------------------------------------------------------------
        // Biometric authentication protection
        // ------------------------------------------------------------------

        // Check if biometrics are available on this device
        const biometricsAvailable = await checkBiometricsAvailable();

        let result: { hash: string };

        if (biometricsAvailable.available) {
          // Prompt for biometric authentication before signing
          const authResult = await biometricSessionManager.authenticateWithBiometrics({
            promptMessage: "Authorize transaction with biometrics",
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

          // Perform the actual signing using the wallet kit
          if (typeof walletKit.signAndSubmitTransaction === "function") {
            const signingResult = await walletKit.signAndSubmitTransaction({
              txXdr,
              rpcUrl,
            });
            const hash = signingResult.hash ?? signingResult.txHash;
            if (!hash) throw new Error("Wallet returned no transaction hash");
            // Poll for chain confirmation before reporting success
            await pollTransaction(rpcUrl, hash);
            showSuccess(hash);
            result = { hash };
          } else if (typeof walletKit.signTransaction !== "function") {
            throw new Error("Wallet does not support transaction signing");
          } else {
            const signed = await walletKit.signTransaction({ txXdr });
            const signedXdr = signed.signedTxXdr ?? signed.signedXdr ?? signed.signed;
            if (!signedXdr) {
              throw new Error("Wallet did not return a signed transaction XDR");
            }

            const submission = await sendTransaction(rpcUrl, signedXdr);

            if (submission.status === "ERROR") {
              throw new Error(`Transaction rejected by network (status: ${submission.status})`);
            }

            // Wait for chain confirmation
            await pollTransaction(rpcUrl, submission.hash);
            showSuccess(submission.hash);
            result = { hash: submission.hash };
          }
        } else {
          // Biometrics not available: sign directly without protection
          // Prefer the full sign-and-submit path if the adapter exposes it
          // (some wallet SDKs handle the broadcast internally).
          if (typeof walletKit.signAndSubmitTransaction === "function") {
            const signingResult = await walletKit.signAndSubmitTransaction({ txXdr, rpcUrl });
            const hash = signingResult.hash ?? signingResult.txHash;
            if (!hash) throw new Error("Wallet returned no transaction hash");
            // Poll for chain confirmation before reporting success
            await pollTransaction(rpcUrl, hash);
            showSuccess(hash);
            return hash;
          }

          // Otherwise: sign → broadcast → poll
          if (typeof walletKit.signTransaction !== "function") {
            throw new Error("Wallet does not support transaction signing");
          }

          const signed = await walletKit.signTransaction({ txXdr });
          const signedXdr = signed.signedTxXdr ?? signed.signedXdr ?? signed.signed;
          if (!signedXdr) {
            throw new Error("Wallet did not return a signed transaction XDR");
          }

          const submission = await sendTransaction(rpcUrl, signedXdr);

          if (submission.status === "ERROR") {
            throw new Error(`Transaction rejected by network (status: ${submission.status})`);
          }

          // Wait for chain confirmation
          await pollTransaction(rpcUrl, submission.hash);
          showSuccess(submission.hash);
          return submission.hash;
        }

        return result.hash;
      } catch (err) {
        void notification("error");
        const msg = err instanceof Error ? err.message : "Failed to submit transaction";
        showError(msg);
        throw err;
      }
    },
    [showPending, showSuccess, showError, rpcUrl, contractId, network.id]
  );

  return submitTx;
}