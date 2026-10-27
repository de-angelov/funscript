import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { Message } from "./protocol.js";

const HEADER_SEPARATOR = "\r\n\r\n";
const CONTENT_LENGTH_PREFIX = "content-length:";

export class MessageReader extends EventEmitter {
  private buffer: Buffer = Buffer.alloc(0);
  private isDisposed = false;

  constructor(private readonly readable: Readable) {
    super();
    this.onData = this.onData.bind(this);
    this.onError = this.onError.bind(this);
    this.onEnd = this.onEnd.bind(this);

    this.readable.on("data", this.onData);
    this.readable.on("error", this.onError);
    this.readable.on("end", this.onEnd);
    this.readable.on("close", this.onEnd);
  }

  private onData(chunk: Buffer | string): void {
    if (this.isDisposed) return;
    const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf-8");
    this.buffer = Buffer.concat([this.buffer, chunkBuffer]);
    this.processBuffer();
  }

  private processBuffer(): void {
    while (true) {
      const headerEndIndex = this.buffer.indexOf(HEADER_SEPARATOR);
      if (headerEndIndex === -1) {
        break;
      }

      const headerText = this.buffer.subarray(0, headerEndIndex).toString("ascii");
      const lines = headerText.split("\r\n");
      let contentLength: number | null = null;

      for (const line of lines) {
        const lower = line.toLowerCase();
        if (lower.startsWith(CONTENT_LENGTH_PREFIX)) {
          const valueStr = line.slice(CONTENT_LENGTH_PREFIX.length).trim();
          const parsed = parseInt(valueStr, 10);
          if (!isNaN(parsed) && parsed >= 0) {
            contentLength = parsed;
          }
        }
      }

      if (contentLength === null) {
        this.emit("error", new Error(`Missing Content-Length in LSP header: ${headerText}`));
        return;
      }

      const bodyStartIndex = headerEndIndex + HEADER_SEPARATOR.length;
      const totalMessageLength = bodyStartIndex + contentLength;

      if (this.buffer.length < totalMessageLength) {
        // Need more data from the stream to complete the body
        break;
      }

      const bodyBuffer = this.buffer.subarray(bodyStartIndex, totalMessageLength);
      this.buffer = this.buffer.subarray(totalMessageLength);

      const bodyString = bodyBuffer.toString("utf-8");
      try {
        const message = JSON.parse(bodyString);
        this.emit("message", message);
      } catch (err) {
        this.emit("error", new Error(`Failed to parse LSP JSON payload: ${bodyString}`));
      }
    }
  }

  private onError(err: Error): void {
    this.emit("error", err);
  }

  private onEnd(): void {
    if (!this.isDisposed) {
      this.emit("close");
    }
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.readable.off("data", this.onData);
    this.readable.off("error", this.onError);
    this.readable.off("end", this.onEnd);
    this.readable.off("close", this.onEnd);
    this.removeAllListeners();
  }
}

export class MessageWriter {
  private isDisposed = false;

  constructor(private readonly writable: Writable) {}

  public write(message: Message): boolean {
    if (this.isDisposed) return false;
    const json = JSON.stringify(message);
    const byteLength = Buffer.byteLength(json, "utf-8");
    const payload = `Content-Length: ${byteLength}\r\n\r\n${json}`;
    return this.writable.write(payload, "utf-8");
  }

  public dispose(): void {
    this.isDisposed = true;
  }
}

export function formatLspMessage(message: Message): string {
  const json = JSON.stringify(message);
  const byteLength = Buffer.byteLength(json, "utf-8");
  return `Content-Length: ${byteLength}\r\n\r\n${json}`;
}
