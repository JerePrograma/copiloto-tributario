const JURISDICTION_POLICIES: Record<string, { requiresPasscode?: boolean }> = {
  "AR-CABA": { requiresPasscode: true },
};

function normalize(value: string): string {
  return value.trim().toUpperCase();
}

export function sanitizeJurisdictions(
  requested: string[] | undefined,
  authenticated: boolean
): string[] | undefined {
  if (!requested) return requested;
  return requested.filter((jurisdiction) => {
    const key = normalize(jurisdiction);
    const policy = JURISDICTION_POLICIES[key];
    if (!policy) return true;
    if (policy.requiresPasscode && !authenticated) {
      return false;
    }
    return true;
  });
}

export function restrictedJurisdictions(authenticated: boolean): string[] {
  if (authenticated) {
    return [];
  }
  return Object.entries(JURISDICTION_POLICIES)
    .filter(([, policy]) => policy.requiresPasscode)
    .map(([key]) => key);
}
