"use client";

import { useEffect } from "react";
import { registerClientObservability } from "../lib/luna2/observability-client";

export default function ObservabilityClient() {
  useEffect(() => registerClientObservability(), []);
  return null;
}
