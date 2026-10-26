import { BrowserBusyError } from '../browser/service.ts';
import { StepError } from '../onboarding/steps.ts';
import { ResourceError } from '../resources/store.ts';
import { HttpError } from './http.ts';

/**
 * Only our own errors choose an HTTP status. A provider error that happens to
 * carry one (AgentMail's 401, say) is a failure on our side: 502, not a hint
 * to the caller that its own token was wrong.
 */
export function errorStatus(err: unknown): number {
  if (err instanceof HttpError || err instanceof BrowserBusyError || err instanceof ResourceError || err instanceof StepError) return err.status;
  return 500;
}
