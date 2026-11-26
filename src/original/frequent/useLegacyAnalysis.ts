import { useEffect, useRef, useState } from "react";
import type { Namespace } from "../model";
import type { ExplanationPackage } from "../explanations/contract";
import { ExplanationSyncRepository } from "../explanations/sync";

const repository = new ExplanationSyncRepository();

/** Read the existing private archive without reactivating superseded explanations. */
export function useLegacyAnalysis(
  owner: string,
  namespace: Namespace,
  packages: ExplanationPackage[],
  enabled: boolean,
) {
  const key = JSON.stringify([owner, namespace]);
  const current = useRef(key);
  current.current = key;
  const [value, setValue] = useState<{
    key: string;
    packages: ExplanationPackage[];
  } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(
    null,
  );
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const changed = () => setRevision((n) => n + 1);
    window.addEventListener("police-explanations-changed", changed);
    return () =>
      window.removeEventListener("police-explanations-changed", changed);
  }, []);
  useEffect(() => {
    if (!enabled || namespace !== "real") return;
    let cancelled = false;
    repository.readForSync(owner).then(
      (snapshot) => {
        if (!cancelled && current.current === key) {
          setValue({ key, packages: snapshot.bundle.legacy });
          setError(null);
        }
      },
      (reason) => {
        if (!cancelled && current.current === key)
          setError({
            key,
            message:
              reason instanceof Error
                ? reason.message
                : "보관된 근거를 읽지 못했습니다.",
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [owner, namespace, key, enabled, packages, revision]);
  return {
    packages:
      namespace === "real" && value?.key === key ? value.packages : packages,
    loading:
      enabled &&
      namespace === "real" &&
      value?.key !== key &&
      error?.key !== key,
    error: error?.key === key ? error.message : "",
    reload: () => setRevision((n) => n + 1),
  };
}
