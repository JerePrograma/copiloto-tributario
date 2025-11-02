export interface SSEMessage<T = unknown> {
  event: string;
  data: T;
}

export interface SSECallbacks<T = unknown> {
  onEvent: (event: SSEMessage<T>) => void;
  onOpen?: (response: Response) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

export interface SSEController {
  abort: () => void;
}

function parseEventBlock(block: string): SSEMessage | null {
  if (!block.trim()) return null;
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join("\n");
  let data: unknown = raw;
  try {
    data = JSON.parse(raw);
  } catch {
    // fallback to raw string
  }
  return { event, data };
}

export function startSSE<T = unknown>(
  url: string,
  init: RequestInit & { signal?: AbortSignal } = {},
  callbacks: SSECallbacks<T>
): SSEController {
  const controller = new AbortController();
  const mergedInit: RequestInit = {
    ...init,
    signal: init.signal
      ? new AbortSignalAny([init.signal, controller.signal])
      : controller.signal,
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  };

  (async () => {
    try {
      const response = await fetch(url, mergedInit);
      if (!response.ok) {
        throw new Error(`SSE request failed: ${response.status}`);
      }
      if (!response.body) {
        throw new Error("SSE response has no body");
      }
      callbacks.onOpen?.(response);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf("\n\n");
        while (idx !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const event = parseEventBlock(chunk);
          if (event) {
            callbacks.onEvent(event as SSEMessage<T>);
          }
          idx = buffer.indexOf("\n\n");
        }
      }
      if (buffer.trim().length > 0) {
        const event = parseEventBlock(buffer);
        if (event) callbacks.onEvent(event as SSEMessage<T>);
      }
    } catch (error) {
      if (!(error instanceof Error)) {
        callbacks.onError?.(new Error("Unknown SSE error"));
      } else if (controller.signal.aborted) {
        // ignore
      } else {
        callbacks.onError?.(error);
      }
    } finally {
      callbacks.onClose?.();
    }
  })();

  return {
    abort: () => controller.abort(),
  };
}

class AbortSignalAny implements AbortSignal {
  readonly aborted: boolean = false;
  readonly reason: unknown;
  readonly [Symbol.toStringTag] = "AbortSignal";
  onabort: ((this: AbortSignal, ev: Event) => void) | null = null;
  private signals: AbortSignal[];
  private abortController = new AbortController();

  constructor(signals: AbortSignal[]) {
    this.signals = signals;
    for (const signal of signals) {
      if (signal.aborted) {
        this.handleAbort(signal.reason);
        break;
      }
      signal.addEventListener("abort", () => this.handleAbort(signal.reason));
    }
  }

  addEventListener(...args: Parameters<AbortSignal["addEventListener"]>): void {
    this.abortController.signal.addEventListener(...args);
  }

  removeEventListener(...args: Parameters<AbortSignal["removeEventListener"]>): void {
    this.abortController.signal.removeEventListener(...args);
  }

  dispatchEvent(event: Event): boolean {
    return this.abortController.signal.dispatchEvent(event);
  }

  throwIfAborted(): void {
    this.abortController.signal.throwIfAborted();
  }

  private handleAbort(reason: unknown) {
    if (this.abortController.signal.aborted) return;
    this.abortController.abort(reason);
    (this as { aborted: boolean }).aborted = true;
    (this as { reason: unknown }).reason = reason;
    this.onabort?.(new Event("abort"));
  }
}
