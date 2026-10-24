/**
 * Notices the identity service sends when something happens to a membership that the member should hear about
 * through a channel established earlier (a contact given at verification), not only in the app: a recovery request
 * opened, proposed or rejected; a bar set or lifted. Two implementations: the server log, and a generic webhook
 * (NOTIFY_WEBHOOK_URL, JSON body) that an operator points at their mail or messaging relay. A failed webhook falls
 * back to the log and reports the failure, so the service can record it and the cranker can retry.
 */
export type NotifyKind =
  "recovery_requested" | "recovery_proposed" | "recovery_rejected" | "barred" | "bar_lifted" | "contact_changed" | "pass_renewed";

export type NotifyEvent = {
  kind: NotifyKind;
  /** Opaque person id (hex); never a name or a credential. */
  personId: string;
  /** The wallet the event is about, when there is one. */
  wallet?: string;
  /** Where to reach the member, when they gave one. The relay decides how. */
  contact?: string;
  /** Unix milliseconds. */
  at: number;
  /** One sentence for the member. */
  detail: string;
  data?: Record<string, string | number>;
};

export interface Notifier {
  /** True when the configured channel took the notice; false when it did not (the log always has it). */
  send(event: NotifyEvent): Promise<boolean>;
}

export class ConsoleNotifier implements Notifier {
  async send(e: NotifyEvent): Promise<boolean> {
    console.log(`[notify] ${e.kind} person ${e.personId.slice(0, 8)}.. ${e.contact ? "(contact on file)" : "(no contact)"}: ${e.detail}`);
    return true;
  }
}

export class WebhookNotifier implements Notifier {
  constructor(
    private readonly url: string,
    private readonly fallback: Notifier = new ConsoleNotifier(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async send(e: NotifyEvent): Promise<boolean> {
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(e),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return true;
    } catch (err) {
      console.error(`[notify] webhook failed (${err instanceof Error ? err.message : String(err)}); logging instead`);
      await this.fallback.send(e);
      return false;
    }
  }
}

/** A notifier that remembers what it was asked to send (tests); `fail` makes it report every notice as undelivered. */
export class MemoryNotifier implements Notifier {
  readonly sent: NotifyEvent[] = [];
  fail = false;
  async send(e: NotifyEvent): Promise<boolean> {
    this.sent.push(e);
    return !this.fail;
  }
}

export function notifierFromEnv(env: Record<string, string | undefined>): Notifier {
  const url = env.NOTIFY_WEBHOOK_URL?.trim();
  return url ? new WebhookNotifier(url) : new ConsoleNotifier();
}
