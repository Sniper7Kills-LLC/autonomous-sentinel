/**
 * Re-export of the git-reviewable default Linguistic Logic fallback
 * prompt (#546).
 *
 * The single source of truth lives in the amplify workspace
 * (`amplify/functions/linguistic/prompts/fallback-system-prompt.ts`),
 * exported as `FALLBACK_SYSTEM_PROMPT`. That file is a pure TypeScript
 * template-literal export with no Amplify runtime dependencies, so the
 * web bundle can import it directly the same way `amplifyClient.ts`
 * imports `amplify/data/resource` — keeping the admin "copy the system
 * default" action byte-for-byte in sync with what the Lambda actually
 * ships, with no duplicated copy to drift.
 */
export { FALLBACK_SYSTEM_PROMPT } from '../../../amplify/functions/linguistic/prompts/fallback-system-prompt';
