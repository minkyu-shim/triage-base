"use client";

import { useEffect, useState } from "react";
import { ModelsResponse } from "../lib/schemas";

// Loads the model menu from GET /api/models. null while loading or if the request fails;
// the pages then let the server use its default model.
export function useModels(): ModelsResponse | null {
  const [models, setModels] = useState<ModelsResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/models")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => {
        const parsed = ModelsResponse.safeParse(data);
        if (!cancelled && parsed.success) setModels(parsed.data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return models;
}
