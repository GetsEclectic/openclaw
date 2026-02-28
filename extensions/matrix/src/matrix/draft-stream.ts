import { editMatrixMessage, deleteMatrixMessage } from "./actions/messages.js";
import { sendMessageMatrix } from "./send.js";

const MATRIX_DRAFT_MIN_CHARS = 5;
const DEFAULT_THROTTLE_MS = 1200;

export type MatrixDraftStream = {
  update: (text: string) => void;
  forceUpdate: (text: string) => void;
  flush: () => Promise<void>;
  stop: () => void;
  clear: () => Promise<void>;
  finalize: (text: string) => Promise<boolean>;
  messageId: () => string | undefined;
};

export function createMatrixDraftStream(params: {
  roomId: string;
  client: import("@vector-im/matrix-bot-sdk").MatrixClient;
  threadId?: string;
  accountId?: string | null;
  throttleMs?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): MatrixDraftStream {
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const replyTarget = `room:${params.roomId}`;

  let streamEventId: string | undefined;
  let lastSentText = "";
  let stopped = false;
  let pendingText = "";
  let lastSentAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  const sendOrEdit = async (text: string): Promise<void> => {
    if (stopped) return;
    const trimmed = text.trimEnd();
    if (!trimmed || trimmed === lastSentText) return;
    lastSentText = trimmed;
    try {
      if (streamEventId) {
        await editMatrixMessage(params.roomId, streamEventId, trimmed, {
          client: params.client,
        });
      } else {
        const result = await sendMessageMatrix(replyTarget, trimmed, {
          client: params.client,
          accountId: params.accountId ?? undefined,
          threadId: params.threadId,
        });
        if (result.messageId) {
          streamEventId = result.messageId;
        } else {
          stopped = true;
          params.warn?.("matrix draft stream: missing event id from send");
          return;
        }
      }
    } catch (err) {
      stopped = true;
      params.warn?.(
        `matrix draft stream failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const runFlush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    while (!stopped && pendingText) {
      if (inFlight) {
        await inFlight;
        continue;
      }
      const text = pendingText;
      pendingText = "";
      inFlight = sendOrEdit(text).finally(() => {
        inFlight = undefined;
      });
      await inFlight;
      lastSentAt = Date.now();
    }
  };

  const schedule = () => {
    if (timer || stopped) return;
    const delay = Math.max(0, throttleMs - (Date.now() - lastSentAt));
    timer = setTimeout(() => {
      timer = undefined;
      void runFlush();
    }, delay);
  };

  const update = (text: string) => {
    const trimmed = text.trimEnd();
    if (!streamEventId && trimmed.length < MATRIX_DRAFT_MIN_CHARS) return;
    if (stopped) return;
    pendingText = trimmed;
    if (inFlight) {
      schedule();
      return;
    }
    if (!timer && Date.now() - lastSentAt >= throttleMs) {
      void runFlush();
      return;
    }
    schedule();
  };

  const forceUpdate = (text: string) => {
    const trimmed = text.trimEnd();
    if (!trimmed || stopped) return;
    pendingText = trimmed;
    if (inFlight) {
      schedule();
      return;
    }
    if (!timer && Date.now() - lastSentAt >= throttleMs) {
      void runFlush();
      return;
    }
    schedule();
  };

  const flush = async (): Promise<void> => {
    await runFlush();
  };

  const stop = (): void => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const waitForInFlight = async (): Promise<void> => {
    if (inFlight) await inFlight;
  };

  const clear = async (): Promise<void> => {
    stop();
    await waitForInFlight();
    const eventId = streamEventId;
    streamEventId = undefined;
    lastSentText = "";
    if (!eventId) return;
    try {
      await deleteMatrixMessage(params.roomId, eventId, { client: params.client });
    } catch (err) {
      params.warn?.(
        `matrix draft stream cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const finalize = async (text: string): Promise<boolean> => {
    stop();
    await waitForInFlight();
    const trimmed = text.trim();
    if (!trimmed || !streamEventId) return false;
    try {
      await editMatrixMessage(params.roomId, streamEventId, trimmed, {
        client: params.client,
      });
      return true;
    } catch (err) {
      params.warn?.(
        `matrix draft stream finalize failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  };

  params.log?.(`matrix draft stream ready (throttleMs=${throttleMs})`);

  return {
    update,
    forceUpdate,
    flush,
    stop,
    clear,
    finalize,
    messageId: () => streamEventId,
  };
}
