import { CdpClient, type CdpClientOptions } from "../cdp/client.js";
import { ensureChrome, type ChromeEndpoint, type EnsureChromeOptions } from "../chrome/launcher.js";
import { CapabilityError, EXIT } from "../run/receipt.js";
import { WORKER_TAB_START_URL } from "./constants.js";
import { rethrow, WorkerTab } from "./tab.js";

export type PageTarget = { targetId: string; url: string; title: string };

export type SessionOptions = {
  chrome?: EnsureChromeOptions;
  cdp?: CdpClientOptions;
};

/**
 * A live connection to the automation Chrome, owning the one worker tab.
 *
 * `open` is the whole preflight this layer is responsible for: Chrome running on
 * the dedicated profile and port (D9), and a browser-level CDP socket that
 * answers. Login, budget, and the tab lease are checked above this — see §8.
 */
export class BrowserSession {
  readonly endpoint: ChromeEndpoint;
  readonly client: CdpClient;

  #tab: WorkerTab | undefined;
  #closed = false;

  private constructor(endpoint: ChromeEndpoint, client: CdpClient) {
    this.endpoint = endpoint;
    this.client = client;
  }

  static async open(opts: SessionOptions = {}): Promise<BrowserSession> {
    const endpoint = await ensureChrome(opts.chrome);
    const client = await CdpClient.connect(endpoint.wsUrl, opts.cdp);
    return new BrowserSession(endpoint, client);
  }

  /** Every page target the browser currently holds — the operator's own tabs
   *  included, which is why nothing here ever acts on one it did not create. */
  async listPageTargets(): Promise<PageTarget[]> {
    try {
      const { targetInfos } = await this.client.send<{
        targetInfos: { targetId: string; type: string; url: string; title: string }[];
      }>("Target.getTargets");
      return targetInfos
        .filter((t) => t.type === "page")
        .map((t) => ({ targetId: t.targetId, url: t.url, title: t.title }));
    } catch (cause) {
      throw rethrow("SESSION_TARGET_LIST_FAILED", "listing browser targets failed", cause);
    }
  }

  /** The single resident worker tab, created in the background so the operator's
   *  window is never yanked, and reused for the whole session (D10). */
  async openWorkerTab(url: string = WORKER_TAB_START_URL, resumeTargetId?: string): Promise<WorkerTab> {
    if (this.#tab) {
      // Two worker tabs would defeat the single-holder tab lease (§8) by
      // construction, so this is a programming error, not a retryable condition.
      throw new CapabilityError({
        code: "SESSION_TAB_ALREADY_OPEN",
        exit: EXIT.GENERIC,
        action: "HALT_AND_NOTIFY",
        retryable: false,
        message: `this session already owns worker tab ${this.#tab.targetId}`,
      });
    }

    let targetId: string;
    if (resumeTargetId !== undefined) {
      const targets = await this.listPageTargets();
      if (!targets.some((target) => target.targetId === resumeTargetId)) {
        throw new CapabilityError({
          code: "RUN_WORKER_TARGET_UNAVAILABLE",
          exit: EXIT.GENERIC,
          action: "HALT_AND_NOTIFY",
          retryable: false,
          message: "the worker tab recorded by this run no longer exists; refusing to reload a proved page",
        });
      }
      this.#tab = await WorkerTab.attach(this.client, resumeTargetId);
      return this.#tab;
    }

    try {
      const created = await this.client.send<{ targetId: string }>("Target.createTarget", {
        url,
        background: true,
      });
      targetId = created.targetId;
    } catch (cause) {
      throw rethrow("SESSION_TAB_CREATE_FAILED", "creating the worker tab failed", cause);
    }

    try {
      this.#tab = await WorkerTab.attach(this.client, targetId);
    } catch (cause) {
      // The tab exists but is unusable; leaving it behind would strand a blank
      // window in the operator's browser for every failed attach.
      try {
        await this.client.send("Target.closeTarget", { targetId });
      } catch {
        /* best effort — the original failure is the one that matters */
      }
      throw cause;
    }
    return this.#tab;
  }

  get tab(): WorkerTab | undefined {
    return this.#tab;
  }

  /**
   * Closes the worker tab and the connection, in that order, leaving the browser
   * as it was found. Idempotent, and never throws: a failed teardown must not
   * mask whatever ended the run.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#tab) {
      await this.#tab.close();
      this.#tab = undefined;
    }
    this.client.close();
  }
}
