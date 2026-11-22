export async function readEventStream(
  response: Response, onData: (data: string) => boolean | void, signal: AbortSignal, onChunk: () => void,
) {
  if (!response.body || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')) {
    void response.body?.cancel().catch(() => {});
    throw new Error('模型接口未返回事件流');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let data: string[] = [];
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });

  function consume(eof: boolean) {
    const endsWithCR = pending.endsWith('\r');
    const lines = pending.split(/\r\n|\r|\n/);
    // Keep a trailing CR until we can tell whether it is followed by LF.
    pending = lines.pop() ?? '';
    if (!eof && endsWithCR) pending = (lines.pop() ?? '') + '\r';
    for (const line of lines) {
      if (line === '') {
        const event = data.join('\n');
        data = [];
        if (event) {
          signal.throwIfAborted();
          const finished = onData(event);
          signal.throwIfAborted();
          if (finished) return true;
        }
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    return false;
  }

  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (!done) onChunk();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (consume(done) || done) return;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
