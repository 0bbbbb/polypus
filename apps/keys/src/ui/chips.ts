/** Monochrome provenance chips — filled dot = live, hollow = simulated/recorded. */
export function statusChip(kind: "live" | "simulated" | "recorded", detail?: string): string {
  const live = kind === "live";
  const label = detail ?? (live ? "Live" : kind === "recorded" ? "Recorded" : "Simulated");
  return `<span class="chip${live ? " chip--live" : ""}"><span class="chip__dot" aria-hidden="true"></span>${label}</span>`;
}

export function statusChipFromLive(isLive: boolean, label?: string): string {
  return statusChip(isLive ? "live" : "simulated", label);
}
