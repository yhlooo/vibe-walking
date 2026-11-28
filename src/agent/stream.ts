/** 从响应体读取 SSE 或 NDJSON，并把完整事件交给协议解析器。 */
export async function readModelStream(
  response: Response, onData: (data: string) => boolean | void, signal: AbortSignal, onChunk: () => void,
  ndjson: boolean,
) {
  const mediaType = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (!response.body || mediaType !== (ndjson ? 'application/x-ndjson' : 'text/event-stream')) {
    void response.body?.cancel().catch(() => {});
    throw new Error('模型接口未返回事件流');
  }

  // 持有同一个解码器处理字节分块，并在取消时结束响应体读取。
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let data: string[] = [];
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });

  // 转发完整事件，在回调前后检查是否已取消。
  function dispatch(event: string) {
    signal.throwIfAborted();
    const finished = onData(event);
    signal.throwIfAborted();
    return finished;
  }

  // 按流格式切分已解码数据，保留跨块的部分事件。
  function consume(eof: boolean) {
    const endsWithCR = pending.endsWith('\r');
    const lines = pending.split(/\r\n|\r|\n/);

    // Keep a trailing CR until we can tell whether it is followed by LF.
    pending = lines.pop() ?? '';
    if (!eof && endsWithCR) pending = (lines.pop() ?? '') + '\r';

    // NDJSON 的最后一条消息可以没有换行符，读到结尾时也应派发。
    if (ndjson && eof) lines.push(pending);
    for (const line of lines) {
      if (ndjson) {
        if (line.trim() && dispatch(line)) return true;
        continue;
      }

      // SSE 用空行分隔事件，同一事件的多条 data 行以换行拼接。
      if (line === '') {
        const event = data.join('\n');
        data = [];
        if (event && dispatch(event)) return true;
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

      // 保留未解完的 UTF-8 字节，并在流结束时冲刷解码器。
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (consume(done) || done) return;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
