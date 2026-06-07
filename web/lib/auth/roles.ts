/**
 * Caller role helpers (#505).
 *
 * Reads the signed-in user's Cognito groups from the idToken's
 * `cognito:groups` claim. Used to gate moderator/admin-only UI (e.g.
 * the recording reprocess button). The server enforces the same
 * authorization on the mutation — these helpers only decide what to
 * render, never what is allowed.
 */

export async function fetchCallerGroups(): Promise<string[]> {
  const { fetchAuthSession } = await import('aws-amplify/auth');
  const session = await fetchAuthSession();
  const raw = session.tokens?.idToken?.payload?.['cognito:groups'];
  return Array.isArray(raw) ? raw.filter((g): g is string => typeof g === 'string') : [];
}

export function isModeratorOrAdmin(groups: readonly string[]): boolean {
  return groups.includes('admin') || groups.includes('moderator');
}

/**
 * Admin-only gate. The Linguistic Logic admin surfaces
 * (LinguisticPromptTemplate / LinguisticRule, #546) are restricted to
 * the `admin` group server-side; this helper mirrors that on the client
 * so moderators don't see admin-only controls. The server still
 * enforces the authorization on every read/mutation — this only decides
 * what to render.
 */
export function isAdmin(groups: readonly string[]): boolean {
  return groups.includes('admin');
}

/**
 * Diagnostics gate (#743/#745). The deep linguistic-trace debug surface is
 * readable by the additive `diagnostics` capability group IN ADDITION TO
 * moderators + admins. The `LinguisticTrace` model enforces the same group
 * set server-side; this only decides what to render.
 */
export function hasDiagnosticsAccess(groups: readonly string[]): boolean {
  return groups.includes('admin') || groups.includes('moderator') || groups.includes('diagnostics');
}
