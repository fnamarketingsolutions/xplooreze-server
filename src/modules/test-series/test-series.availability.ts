export type AvailabilityWindow = {
  startsAt: Date | null;
  endsAt: Date | null;
};

export function isAvailabilityWindowOpen(availability: AvailabilityWindow, now: Date): boolean {
  if (availability.startsAt != null && now < availability.startsAt) {
    return false;
  }

  if (availability.endsAt != null && now >= availability.endsAt) {
    return false;
  }

  return true;
}
