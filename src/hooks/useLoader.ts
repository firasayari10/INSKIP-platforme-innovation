import { useCallback, useEffect, useState } from "react";
import type { Result } from "@/domain/result";

export type LoadState<T, E> = { status: "loading" } | { status: "error"; error: E } | { status: "ready"; data: T };

/** Charge une donnée asynchrone et expose un rechargement. Ignore les réponses arrivées après démontage. */
export function useLoader<T, E>(load: () => Promise<Result<T, E>>, deps: unknown[]) {
  const [state, setState] = useState<LoadState<T, E>>({ status: "loading" });
  const [version, setVersion] = useState(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableLoad = useCallback(load, deps);

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    stableLoad().then(result => {
      if (!active) return;
      setState(result.ok ? { status: "ready", data: result.value } : { status: "error", error: result.error });
    });
    return () => {
      active = false;
    };
  }, [stableLoad, version]);

  return { state, reload: () => setVersion(v => v + 1) };
}
